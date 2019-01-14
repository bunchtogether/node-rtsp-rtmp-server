/*
 * decaffeinate suggestions:
 * DS102: Remove unnecessary code created because of implicit returns
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
const net = require('net');
const fs = require('fs');

const config = require('./config');
const avstreams = require('./avstreams');
const hybrid_udp = require('./hybrid_udp');
const logger = require('./logger');

const TAG = 'custom_receiver';

class CustomReceiver {
  constructor(type, callback) {
    this.type = type;
    if ((callback == null)) {
      throw new Error("Mandatory callback argument is not passed");
    }
    if ((callback.videoControl == null)) {
      throw new Error("Mandatory callback.videoControl is not passed");
    }
    if ((callback.audioControl == null)) {
      throw new Error("Mandatory callback.audioControl is not passed");
    }
    if ((callback.videoData == null)) {
      throw new Error("Mandatory callback.videoData is not passed");
    }
    if ((callback.audioData == null)) {
      throw new Error("Mandatory callback.audioData is not passed");
    }

    // We create four separate sockets for receiving different kinds of data.
    // If we have just one socket for receiving all kinds of data, the sender
    // has to lock and synchronize audio/video writer threads and it leads to
    // slightly worse performance.
    if (['unix', 'tcp'].includes(this.type)) {
      this.videoControlReceiver = this.createReceiver('VideoControl', callback.videoControl);
      this.audioControlReceiver = this.createReceiver('AudioControl', callback.audioControl);
      this.videoDataReceiver = this.createReceiver('VideoData', callback.videoData);
      this.audioDataReceiver = this.createReceiver('AudioData', callback.audioData);
    } else if (this.type === 'udp') {
      this.videoControlReceiver = new hybrid_udp.UDPServer;
      this.videoControlReceiver.name = 'VideoControl';
      this.videoControlReceiver.on('packet', (buf, addr, port) => {
        let streamId;
        logger.info("[custom_receiver] started receiving video");
        if (buf.length >= 5) {
          streamId = buf.toString('utf8', 4);
        } else {
          streamId = "public";  // TODO: Use default value or throw error?
        }
        this.setInternalStreamId(streamId);
        return callback.videoControl(this.getInternalStream(), buf.slice(3));
    });
      this.audioControlReceiver = new hybrid_udp.UDPServer;
      this.audioControlReceiver.name = 'AudioControl';
      this.audioControlReceiver.on('packet', (buf, addr, port) => {
        logger.info("[custom_receiver] started receiving audio");
        return callback.audioControl(this.getInternalStream(), buf.slice(3));
    });
      this.videoDataReceiver = new hybrid_udp.UDPServer;
      this.videoDataReceiver.name = 'VideoData';
      this.videoDataReceiver.on('packet', (buf, addr, port) => {
        return callback.videoData(this.getInternalStream(), buf.slice(3));
    });
      this.audioDataReceiver = new hybrid_udp.UDPServer;
      this.audioDataReceiver.name = 'AudioData';
      this.audioDataReceiver.on('packet', (buf, addr, port) => {
        return callback.audioData(this.getInternalStream(), buf.slice(3));
    });
    } else {
      throw new Error(`unknown receiver type: ${this.type}`);
    }
  }

  getInternalStream() {
    if ((this.internalStream == null)) {
      logger.warn('[rtsp] warn: Internal stream name not known; using default "public"');
      const streamId = 'public';  // TODO: Use default value or throw error?
      this.internalStream = avstreams.getOrCreate(streamId);
    }
    return this.internalStream;
  }

  setInternalStreamId(streamId) {
    if ((this.internalStream != null) && (this.internalStream.id !== streamId)) {
      avstreams.remove(this.internalStream);
    }
    logger.info(`[rtsp] internal stream name has been set to: ${streamId}`);
    let stream = avstreams.get(streamId);
    if (stream != null) {
      logger.info("[rtsp] resetting existing stream");
      stream.reset();
    } else {
      stream = avstreams.create(streamId);
      stream.type = avstreams.STREAM_TYPE_LIVE;
    }
    return this.internalStream = stream;
  }

  start() {
    if (this.type === 'unix') {
      return this.startUnix();
    } else if (this.type === 'tcp') {
      return this.startTCP();
    } else if (this.type === 'udp') {
      return this.startUDP();
    } else {
      throw new Error(`unknown receiverType in config: ${this.type}`);
    }
  }

  startUnix() {
    this.videoControlReceiver.listen(config.videoControlReceiverPath, function() {
      fs.chmodSync(config.videoControlReceiverPath, '777');
      return logger.debug(`[${TAG}] videoControl socket: ${config.videoControlReceiverPath}`);
    });
    this.audioControlReceiver.listen(config.audioControlReceiverPath, function() {
      fs.chmodSync(config.audioControlReceiverPath, '777');
      return logger.debug(`[${TAG}] audioControl socket: ${config.audioControlReceiverPath}`);
    });
    this.videoDataReceiver.listen(config.videoDataReceiverPath, function() {
      fs.chmodSync(config.videoDataReceiverPath, '777');
      return logger.debug(`[${TAG}] videoData socket: ${config.videoDataReceiverPath}`);
    });
    return this.audioDataReceiver.listen(config.audioDataReceiverPath, function() {
      fs.chmodSync(config.audioDataReceiverPath, '777');
      return logger.debug(`[${TAG}] audioData socket: ${config.audioDataReceiverPath}`);
    });
  }

  startTCP() {
    this.videoControlReceiver.listen(config.videoControlReceiverPort,
      config.receiverListenHost, config.receiverTCPBacklog, () => logger.debug(`[${TAG}] videoControl socket: tcp:${config.videoControlReceiverPort}`));
    this.audioControlReceiver.listen(config.audioControlReceiverPort,
      config.receiverListenHost, config.receiverTCPBacklog, () => logger.debug(`[${TAG}] audioControl socket: tcp:${config.audioControlReceiverPort}`));
    this.videoDataReceiver.listen(config.videoDataReceiverPort,
      config.receiverListenHost, config.receiverTCPBacklog, () => logger.debug(`[${TAG}] videoData socket: tcp:${config.videoDataReceiverPort}`));
    return this.audioDataReceiver.listen(config.audioDataReceiverPort,
      config.receiverListenHost, config.receiverTCPBacklog, () => logger.debug(`[${TAG}] audioData socket: tcp:${config.audioDataReceiverPort}`));
  }

  startUDP() {
    this.videoControlReceiver.start(config.videoControlReceiverPort, config.receiverListenHost, () => logger.debug(`[${TAG}] videoControl socket: udp:${config.videoControlReceiverPort}`));
    this.audioControlReceiver.start(config.audioControlReceiverPort, config.receiverListenHost, () => logger.debug(`[${TAG}] audioControl socket: udp:${config.audioControlReceiverPort}`));
    this.videoDataReceiver.start(config.videoDataReceiverPort, config.receiverListenHost, () => logger.debug(`[${TAG}] videoData socket: udp:${config.videoDataReceiverPort}`));
    return this.audioDataReceiver.start(config.audioDataReceiverPort, config.receiverListenHost, () => logger.debug(`[${TAG}] audioData socket: udp:${config.audioDataReceiverPort}`));
  }

  // Delete UNIX domain sockets
  deleteReceiverSocketsSync() {
    if (this.type === 'unix') {
      let e;
      if (fs.existsSync(config.videoControlReceiverPath)) {
        try {
          fs.unlinkSync(config.videoControlReceiverPath);
        } catch (error) {
          e = error;
          logger.error(`unlink error: ${e}`);
        }
      }
      if (fs.existsSync(config.audioControlReceiverPath)) {
        try {
          fs.unlinkSync(config.audioControlReceiverPath);
        } catch (error1) {
          e = error1;
          logger.error(`unlink error: ${e}`);
        }
      }
      if (fs.existsSync(config.videoDataReceiverPath)) {
        try {
          fs.unlinkSync(config.videoDataReceiverPath);
        } catch (error2) {
          e = error2;
          logger.error(`unlink error: ${e}`);
        }
      }
      if (fs.existsSync(config.audioDataReceiverPath)) {
        try {
          fs.unlinkSync(config.audioDataReceiverPath);
        } catch (error3) {
          e = error3;
          logger.error(`unlink error: ${e}`);
        }
      }
    }
  }

  createReceiver(name, callback) {
    return net.createServer(c => {
      logger.info(`[custom_receiver] new connection to ${name}`);
      let buf = null;
      c.on('close', () => logger.info(`[custom_receiver] connection to ${name} closed`));
      return c.on('data', data => {
        if (config.debug.dropAllData) {
          return;
        }
        if (buf != null) {
          buf = Buffer.concat([buf, data]);
        } else {
          buf = data;
        }
        if (buf.length >= 3) {  // 3 bytes == payload size
          while (true) {
            const payloadSize = (buf[0] * 0x10000) + (buf[1] * 0x100) + buf[2];
            const totalSize = payloadSize + 3;  // 3 bytes for payload size
            if (buf.length >= totalSize) {
              if (name === 'VideoControl') {  // parse stream name
                var streamId;
                if (buf.length >= 5) {
                  streamId = buf.toString('utf8', 4, totalSize);
                } else {
                  streamId = "public";  // TODO: Use default value or throw error?
                }
                this.setInternalStreamId(streamId);
              }

              // 3 bytes for payload size
              callback(this.getInternalStream(), buf.slice(3, totalSize));
              if (buf.length > totalSize) {
                buf = buf.slice(totalSize);
              } else {
                buf = null;
                break;
              }
            } else {
              break;
            }
          }
        }
      });
    });
  }
}

module.exports = CustomReceiver;
