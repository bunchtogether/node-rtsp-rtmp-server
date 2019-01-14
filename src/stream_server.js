/* eslint-disable
    consistent-return,
    no-param-reassign,
    no-return-assign,
    no-unused-vars,
    one-var,
*/
// TODO: This file was created by bulk-decaffeinate.
// Fix any style issues and re-enable lint.
/*
 * decaffeinate suggestions:
 * DS101: Remove unnecessary use of Array.from
 * DS102: Remove unnecessary code created because of implicit returns
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
// RTSP and RTMP/RTMPE/RTMPT/RTMPTE server implementation.
// Also serves HTTP contents as this server is meant to
// be run on port 80.

const net = require('net');
const fs = require('fs');
const crypto = require('crypto');

const config = require('./config');
const rtmp = require('./rtmp');
const http = require('./http');
const rtsp = require('./rtsp');
const h264 = require('./h264');
const aac = require('./aac');
const mp4 = require('./mp4');
const Bits = require('./bits');
const avstreams = require('./avstreams');
const CustomReceiver = require('./custom_receiver');
const logger = require('./logger');
const packageJson = require('../package.json');

const Sequent = require('sequent');

// If true, incoming video/audio packets are printed to the console
const DEBUG_INCOMING_PACKET_DATA = false;

// If true, hash value of each incoming video/audio access unit is printed to the console
const DEBUG_INCOMING_PACKET_HASH = false;

// # Default server name for RTSP and HTTP responses
const DEFAULT_SERVER_NAME = `node-rtsp-rtmp-server/${packageJson.version}`;

const serverName = config.serverName != null ? config.serverName : DEFAULT_SERVER_NAME;

class StreamServer {
  constructor(opts) {
    this.serverName = (opts != null ? opts.serverName : undefined) != null ? (opts != null ? opts.serverName : undefined) : serverName;

    if (config.enableRTMP || config.enableRTMPT) {
      // Create RTMP server
      this.rtmpServer = new rtmp.RTMPServer();
      this.rtmpServer.on('video_start', (streamId) => {
        const stream = avstreams.getOrCreate(streamId);
        return this.onReceiveVideoControlBuffer(stream);
      });
      this.rtmpServer.on('video_data', (streamId, pts, dts, nalUnits) => {
        const stream = avstreams.get(streamId);
        if (stream != null) {
          return this.onReceiveVideoPacket(stream, nalUnits, pts, dts);
        }
        return logger.warn(`warn: Received invalid streamId from rtmp: ${streamId}`);
      });
      this.rtmpServer.on('audio_start', (streamId) => {
        const stream = avstreams.getOrCreate(streamId);
        return this.onReceiveAudioControlBuffer(stream);
      });
      this.rtmpServer.on('audio_data', (streamId, pts, dts, adtsFrame) => {
        const stream = avstreams.get(streamId);
        if (stream != null) {
          return this.onReceiveAudioPacket(stream, adtsFrame, pts, dts);
        }
        return logger.warn(`warn: Received invalid streamId from rtmp: ${streamId}`);
      });
    }

    if (config.enableCustomReceiver) {
      // Setup data receivers for custom protocol
      this.customReceiver = new CustomReceiver(config.receiverType, {
        videoControl: (...args) => this.onReceiveVideoControlBuffer(...Array.from(args || [])),
        audioControl: (...args) => this.onReceiveAudioControlBuffer(...Array.from(args || [])),
        videoData: (...args) => this.onReceiveVideoDataBuffer(...Array.from(args || [])),
        audioData: (...args) => this.onReceiveAudioDataBuffer(...Array.from(args || [])),
      },
      );

      // Delete old sockets
      this.customReceiver.deleteReceiverSocketsSync();
    }

    if (config.enableHTTP) {
      this.httpHandler = new http.HTTPHandler({
        serverName: this.serverName,
        documentRoot: (opts != null ? opts.documentRoot : undefined),
      });
    }

    if (config.enableRTSP || config.enableHTTP || config.enableRTMPT) {
      let httpHandler,
        rtmptCallback;
      if (config.enableRTMPT) {
        rtmptCallback = (...args) => this.rtmpServer.handleRTMPTRequest(...Array.from(args || []));
      } else {
        rtmptCallback = null;
      }
      if (config.enableHTTP) {
        ({ httpHandler } = this);
      } else {
        httpHandler = null;
      }
      this.rtspServer = new rtsp.RTSPServer({
        serverName: this.serverName,
        httpHandler,
        rtmptCallback,
      });
      this.rtspServer.on('video_start', (stream) => this.onReceiveVideoControlBuffer(stream));
      this.rtspServer.on('audio_start', (stream) => this.onReceiveAudioControlBuffer(stream));
      this.rtspServer.on('video', (stream, nalUnits, pts, dts) => this.onReceiveVideoNALUnits(stream, nalUnits, pts, dts));
      this.rtspServer.on('audio', (stream, accessUnits, pts, dts) => this.onReceiveAudioAccessUnits(stream, accessUnits, pts, dts));
    }

    avstreams.on('new', (stream) => {
      if (DEBUG_INCOMING_PACKET_HASH) {
        return stream.lastSentVideoTimestamp = 0;
      }
    });

    avstreams.on('reset', (stream) => {
      if (DEBUG_INCOMING_PACKET_HASH) {
        return stream.lastSentVideoTimestamp = 0;
      }
    });

    avstreams.on('end', (stream) => {
      if (config.enableRTSP) {
        this.rtspServer.sendEOS(stream);
      }
      if (config.enableRTMP || config.enableRTMPT) {
        return this.rtmpServer.sendEOS(stream);
      }
    });

    // for mp4
    avstreams.on('audio_data', (stream, data, pts) => this.onReceiveAudioAccessUnits(stream, [data], pts, pts));

    avstreams.on('video_data', (stream, nalUnits, pts, dts) => {
      if ((dts == null)) {
        dts = pts;
      }
      return this.onReceiveVideoNALUnits(stream, nalUnits, pts, dts);
    });

    avstreams.on('audio_start', (stream) => this.onReceiveAudioControlBuffer(stream));

    avstreams.on('video_start', (stream) => this.onReceiveVideoControlBuffer(stream));
  }

  // # TODO: Do we need to do something for remove_stream event?
  // avstreams.on 'remove_stream', (stream) ->
  //  logger.raw "received remove_stream event from stream #{stream.id}"

  attachRecordedDir(dir) {
    if (config.recordedApplicationName != null) {
      logger.info(`attachRecordedDir: dir=${dir} app=${config.recordedApplicationName}`);
      return avstreams.attachRecordedDirToApp(dir, config.recordedApplicationName);
    }
  }

  attachMP4(filename, streamName) {
    logger.info(`attachMP4: file=${filename} stream=${streamName}`);

    const context = this;
    const generator = new avstreams.AVStreamGenerator({
      // Generate an AVStream upon request
      generate() {
        let mp4File;
        try {
          mp4File = new mp4.MP4File(filename);
        } catch (err) {
          logger.error(`error opening MP4 file ${filename}: ${err}`);
          return null;
        }
        const streamId = avstreams.createNewStreamId();
        const mp4Stream = new avstreams.MP4Stream(streamId);
        logger.info(`created stream ${streamId} from ${filename}`);
        avstreams.emit('new', mp4Stream);
        avstreams.add(mp4Stream);

        mp4Stream.type = avstreams.STREAM_TYPE_RECORDED;
        const audioSpecificConfig = null;
        mp4File.on('audio_data', (data, pts) => context.onReceiveAudioAccessUnits(mp4Stream, [data], pts, pts));
        mp4File.on('video_data', (nalUnits, pts, dts) => {
          if ((dts == null)) {
            dts = pts;
          }
          return context.onReceiveVideoNALUnits(mp4Stream, nalUnits, pts, dts);
        });
        mp4File.on('eof', () => mp4Stream.emit('end'));
        mp4File.parse();
        mp4Stream.updateSPS(mp4File.getSPS());
        mp4Stream.updatePPS(mp4File.getPPS());
        const ascBuf = mp4File.getAudioSpecificConfig();
        const bits = new Bits(ascBuf);
        const ascInfo = aac.readAudioSpecificConfig(bits);
        mp4Stream.updateConfig({
          audioSpecificConfig: ascBuf,
          audioASCInfo: ascInfo,
          audioSampleRate: ascInfo.samplingFrequency,
          audioClockRate: 90000,
          audioChannels: ascInfo.channelConfiguration,
          audioObjectType: ascInfo.audioObjectType,
        });
        mp4Stream.durationSeconds = mp4File.getDurationSeconds();
        mp4Stream.lastTagTimestamp = mp4File.getLastTimestamp();
        mp4Stream.mp4File = mp4File;
        mp4File.fillBuffer(() => {
          context.onReceiveAudioControlBuffer(mp4Stream);
          return context.onReceiveVideoControlBuffer(mp4Stream);
        });
        return mp4Stream;
      },

      play() {
        return this.mp4File.play();
      },

      pause() {
        return this.mp4File.pause();
      },

      resume() {
        return this.mp4File.resume();
      },

      seek(seekSeconds, callback) {
        const actualStartTime = this.mp4File.seek(seekSeconds);
        return callback(null, actualStartTime);
      },

      sendVideoPacketsSinceLastKeyFrame(endSeconds, callback) {
        return this.mp4File.sendVideoPacketsSinceLastKeyFrame(endSeconds, callback);
      },

      teardown() {
        this.mp4File.close();
        return this.destroy();
      },

      getCurrentPlayTime() {
        return this.mp4File.currentPlayTime;
      },

      isPaused() {
        return this.mp4File.isPaused();
      },
    });

    return avstreams.addGenerator(streamName, generator);
  }

  stop(callback) {
    if (config.enableCustomReceiver) {
      this.customReceiver.deleteReceiverSocketsSync();
    }
    return (typeof callback === 'function' ? callback() : undefined);
  }

  start(callback) {
    const seq = new Sequent();
    let waitCount = 0;

    if (config.enableRTMP) {
      waitCount++;
      this.rtmpServer.start({ port: config.rtmpServerPort }, () => seq.done());
    }
    // RTMP server is ready

    if (config.enableCustomReceiver) {
      // Start data receivers for custom protocol
      this.customReceiver.start();
    }

    if (config.enableRTSP || config.enableHTTP || config.enableRTMPT) {
      waitCount++;
      this.rtspServer.start({ port: config.serverPort }, () => seq.done());
    }

    return seq.wait(waitCount, () => (typeof callback === 'function' ? callback() : undefined));
  }

  setLivePathConsumer(func) {
    if (config.enableRTSP) {
      return this.rtspServer.setLivePathConsumer(func);
    }
  }

  setAuthenticator(func) {
    if (config.enableRTSP) {
      return this.rtspServer.setAuthenticator(func);
    }
  }

  // buf argument can be null (not used)
  onReceiveVideoControlBuffer(stream, buf) {
    stream.resetFrameRate(stream);
    stream.isVideoStarted = true;
    stream.timeAtVideoStart = Date.now();
    return stream.timeAtAudioStart = stream.timeAtVideoStart;
  }
  //  stream.spropParameterSets = ''

  // buf argument can be null (not used)
  onReceiveAudioControlBuffer(stream, buf) {
    stream.isAudioStarted = true;
    stream.timeAtAudioStart = Date.now();
    return stream.timeAtVideoStart = stream.timeAtAudioStart;
  }

  onReceiveVideoDataBuffer(stream, buf) {
    const pts = (buf[1] * 0x010000000000) +
      (buf[2] * 0x0100000000) +
      (buf[3] * 0x01000000) +
      (buf[4] * 0x010000) +
      (buf[5] * 0x0100) +
      buf[6];
    // TODO: Support dts
    const dts = pts;
    const nalUnit = buf.slice(7);
    return this.onReceiveVideoPacket(stream, nalUnit, pts, dts);
  }

  onReceiveAudioDataBuffer(stream, buf) {
    const pts = (buf[1] * 0x010000000000) +
      (buf[2] * 0x0100000000) +
      (buf[3] * 0x01000000) +
      (buf[4] * 0x010000) +
      (buf[5] * 0x0100) +
      buf[6];
    // TODO: Support dts
    const dts = pts;
    const adtsFrame = buf.slice(7);
    return this.onReceiveAudioPacket(stream, adtsFrame, pts, dts);
  }

  // nal_unit_type 5 must not separated with 7 and 8 which
  // share the same timestamp as 5
  onReceiveVideoNALUnits(stream, nalUnits, pts, dts) {
    if (DEBUG_INCOMING_PACKET_DATA) {
      logger.info(`receive video: num_nal_units=${nalUnits.length} pts=${pts}`);
    }

    if (config.enableRTSP) {
      // rtspServer will parse nalUnits and updates SPS/PPS for the stream,
      // so we don't need to parse them here.
      // TODO: Should SPS/PPS be parsed here?
      this.rtspServer.sendVideoData(stream, nalUnits, pts, dts);
    }

    if (config.enableRTMP || config.enableRTMPT) {
      this.rtmpServer.sendVideoPacket(stream, nalUnits, pts, dts);
    }

    let hasVideoFrame = false;
    for (const nalUnit of Array.from(nalUnits)) {
      const nalUnitType = h264.getNALUnitType(nalUnit);
      if (nalUnitType === h264.NAL_UNIT_TYPE_SPS) { // 7
        stream.updateSPS(nalUnit);
      } else if (nalUnitType === h264.NAL_UNIT_TYPE_PPS) { // 8
        stream.updatePPS(nalUnit);
      } else if ((nalUnitType === h264.NAL_UNIT_TYPE_IDR_PICTURE) ||
        (nalUnitType === h264.NAL_UNIT_TYPE_NON_IDR_PICTURE)) { // 5 (key frame) or 1 (inter frame)
        hasVideoFrame = true;
      }
      if (DEBUG_INCOMING_PACKET_HASH) {
        const md5 = crypto.createHash('md5');
        md5.update(nalUnit);
        const tsDiff = pts - stream.lastSentVideoTimestamp;
        logger.info(`video: pts=${pts} pts_diff=${tsDiff} md5=${md5.digest('hex').slice(0, 7)} nal_unit_type=${nalUnitType} bytes=${nalUnit.length}`);
        stream.lastSentVideoTimestamp = pts;
      }
    }

    if (hasVideoFrame) {
      stream.calcFrameRate(pts);
    }
  }

  // Takes H.264 NAL units separated by start code (0x000001)
  //
  // arguments:
  //   nalUnit: Buffer
  //   pts: timestamp in 90 kHz clock rate (PTS)
  onReceiveVideoPacket(stream, nalUnitGlob, pts, dts) {
    const nalUnits = h264.splitIntoNALUnits(nalUnitGlob);
    if (nalUnits.length === 0) {
      return;
    }
    this.onReceiveVideoNALUnits(stream, nalUnits, pts, dts);
  }

  // pts, dts: in 90KHz clock rate
  onReceiveAudioAccessUnits(stream, accessUnits, pts, dts) {
    if (config.enableRTSP) {
      this.rtspServer.sendAudioData(stream, accessUnits, pts, dts);
    }

    if (DEBUG_INCOMING_PACKET_DATA) {
      logger.info(`receive audio: num_access_units=${accessUnits.length} pts=${pts}`);
    }

    const ptsPerFrame = 90000 / (stream.audioSampleRate / 1024);

    for (let i = 0; i < accessUnits.length; i++) {
      const accessUnit = accessUnits[i];
      if (DEBUG_INCOMING_PACKET_HASH) {
        const md5 = crypto.createHash('md5');
        md5.update(accessUnit);
        logger.info(`audio: pts=${pts} md5=${md5.digest('hex').slice(0, 7)} bytes=${accessUnit.length}`);
      }
      if (config.enableRTMP || config.enableRTMPT) {
        this.rtmpServer.sendAudioPacket(stream, accessUnit,
          Math.round(pts + (ptsPerFrame * i)),
          Math.round(dts + (ptsPerFrame * i)));
      }
    }
  }

  // pts, dts: in 90KHz clock rate
  onReceiveAudioPacket(stream, adtsFrameGlob, pts, dts) {
    const adtsFrames = aac.splitIntoADTSFrames(adtsFrameGlob);
    if (adtsFrames.length === 0) {
      return;
    }
    const adtsInfo = aac.parseADTSFrame(adtsFrames[0]);

    const isConfigUpdated = false;

    stream.updateConfig({
      audioSampleRate: adtsInfo.sampleRate,
      audioClockRate: adtsInfo.sampleRate,
      audioChannels: adtsInfo.channels,
      audioObjectType: adtsInfo.audioObjectType,
    });

    const rtpTimePerFrame = 1024;

    const rawDataBlocks = [];
    for (let i = 0; i < adtsFrames.length; i++) {
      const adtsFrame = adtsFrames[i];
      const rawDataBlock = adtsFrame.slice(7);
      rawDataBlocks.push(rawDataBlock);
    }

    return this.onReceiveAudioAccessUnits(stream, rawDataBlocks, pts, dts);
  }
}

module.exports = StreamServer;
