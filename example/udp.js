/* eslint-disable
    camelcase,
    consistent-return,
    no-console,
*/
// TODO: This file was created by bulk-decaffeinate.
// Fix any style issues and re-enable lint.
/*
 * decaffeinate suggestions:
 * DS101: Remove unnecessary use of Array.from
 * DS102: Remove unnecessary code created because of implicit returns
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
// Read MPEG-TS file and feed the audio/video frames into the RTSP server.

const hybrid_udp = require('../hybrid_udp');
const h264 = require('../h264');
const aac = require('../aac');
const mpegts = require('../mpegts');

// -- Modify from here
const INPUT_FILE = 'test.ts'; // MPEG-TS file up to 1GB
// To convert from MP4 with H.264 video and AAC audio to MPEG-TS, run:
// $ ffmpeg -i input.mp4 -c:v copy -c:a copy -bsf h264_mp4toannexb output.ts

// If STREAM_NAME is "myStream", the stream will be accessible at
// rtsp://localhost:80/live/myStream and rtmp://localhost/live/myStream
const STREAM_NAME = 'myStream';

const SERVER_HOST = 'localhost';
// Put the same values as the server's config.coffee.
// Normally you don't need to change these values.
const VIDEO_CONTROL_PORT = 1111;
const AUDIO_CONTROL_PORT = 1112;
const VIDEO_DATA_PORT = 1113;
const AUDIO_DATA_PORT = 1114;

const UDP_MAX_PACKET_SIZE = 8000;
// -- To here

const videoControlClient = new hybrid_udp.UDPClient();
videoControlClient.maxPacketSize = UDP_MAX_PACKET_SIZE;
const audioControlClient = new hybrid_udp.UDPClient();
audioControlClient.maxPacketSize = UDP_MAX_PACKET_SIZE;
const videoDataClient = new hybrid_udp.UDPClient();
videoDataClient.maxPacketSize = UDP_MAX_PACKET_SIZE;
const audioDataClient = new hybrid_udp.UDPClient();
audioDataClient.maxPacketSize = UDP_MAX_PACKET_SIZE;

let isVideoEnded = false;
let isAudioEnded = false;

// Check if both audio and video streams reached EOF
const checkEnd = function () {
  if (isVideoEnded && isAudioEnded) {
    aac.close();
    videoControlClient.stop();
    audioControlClient.stop();
    videoDataClient.stop();
    audioDataClient.stop();
    return console.log('all done');
  }
};

/*
Packet format

packet {
  payload_size (3 bytes)  Length of this packet excluding payload_size, in uint24.
  packet_type (1 byte)    Type of this packet.
  if (packet_type == 0) { // video start: notify the start of video stream
    // No data after packet_type
  } else if (packet_type == 1) { // audio start: notify the start of audio stream
    // No data after packet_type
  } else if (packet_type == 2) { // video data
    PTS (6 bytes)              PTS in uint48. DTS has the same value.
    payload (remaining bytes)  One or more NAL units with start code prefix.
  } else if (packet_type == 3) { // audio data
    PTS (6 bytes)              PTS in uint48. DTS has the same value.
    payload (remaining bytes)  One or more ADTS frames containing AAC raw data.
  }
}
*/

// Notify the start of video stream
const sendVideoStart = function (callback) {
  console.log('send video start');
  const streamNameBuf = new Buffer(STREAM_NAME, 'utf8');
  const payloadSize = 1 + streamNameBuf.length;
  let buf = new Buffer([
    // Payload size (24 bit unsigned integer)
    (payloadSize >> 16) & 0xff,
    (payloadSize >> 8) & 0xff,
    payloadSize & 0xff,

    // packet type (0x00 == video start)
    0x00,
  ]);
  buf = Buffer.concat([buf, streamNameBuf], 4 + streamNameBuf.length);
  try {
    return videoControlClient.writeReliable(buf, callback);
  } catch (e) {
    return console.log(`video start write error: ${e}`);
  }
};

// Notify the start of audio stream
const sendAudioStart = function (callback) {
  console.log('send audio start');
  const payloadSize = 1;
  const buf = new Buffer([
    // Payload size (24 bit unsigned integer)
    (payloadSize >> 16) & 0xff,
    (payloadSize >> 8) & 0xff,
    payloadSize & 0xff,

    // packet type (0x01 == audio start)
    0x01,
  ]);
  try {
    return audioControlClient.writeReliable(buf, callback);
  } catch (e) {
    return console.log(`audio start write error: ${e}`);
  }
};

// Called when H.264 parser recognizes one or more NAL units
// @param pts (number): PTS for the NAL units
// @param dts (number): DTS for the NAL units
// @param nalUnits (array): Array of Buffer instances of NAL units.
//                          NAL units do not contain start code prefix.
h264.on('dts_nal_units', (pts, dts, nalUnits) => {
  let isImportant = false;

  // Put start code prefix (0x00000001) before each NAL unit
  const nalUnitTypes = [];
  const nalUnitsWithStartCode = [];
  for (const nalUnit of Array.from(nalUnits)) {
    nalUnitTypes.push(nalUnit[0] & 0x1f);
    nalUnitsWithStartCode.push(new Buffer([0x00, 0x00, 0x00, 0x01]));
    nalUnitsWithStartCode.push(nalUnit);
    const nalUnitType = h264.getNALUnitType(nalUnit);
    if ([7, 8].includes(nalUnitType)) {
      isImportant = true;
    }
  }

  // Concatenate all NAL units into a single buffer
  const concatNALUnit = Buffer.concat(nalUnitsWithStartCode);

  const payloadSize = concatNALUnit.length + 7; // 1 (packet type) + 6 (PTS)
  let buf = new Buffer([
    // Payload size (24 bit unsigned integer)
    (payloadSize >> 16) & 0xff,
    (payloadSize >> 8) & 0xff,
    payloadSize & 0xff,

    // packet type (0x02 == video data)
    0x02,
    // PTS (== DTS) in 90000 Hz clock rate (48 bit unsigned integer)
    (pts / 0x10000000000) & 0xff,
    (pts / 0x100000000) & 0xff,
    (pts / 0x1000000) & 0xff,
    (pts / 0x10000) & 0xff,
    (pts / 0x100) & 0xff,
    pts & 0xff,
  ]);
  buf = Buffer.concat([buf, concatNALUnit]);
  console.log(`send video: pts=${pts} dts=${dts} len=${concatNALUnit.length} nal_unit_types=${nalUnitTypes.join(',')}`);
  try {
    if (isImportant) {
      return videoDataClient.writeReliable(buf);
    }
    return videoDataClient.write(buf);
  } catch (e) {
    return console.log(`video write error: ${e}`);
  }
});

// Called when AAC (ADTS) parser recognizes one or more ADTS frames
aac.on('dts_adts_frames', (pts, dts, adtsFrames) => {
  // Concatenate all ADTS frames into a single buffer
  const concatADTSFrame = Buffer.concat(adtsFrames);

  const payloadSize = concatADTSFrame.length + 7; // 1 (packet type) + 6 (PTS)
  let buf = new Buffer([
    // Payload size (24 bit unsigned integer)
    (payloadSize >> 16) & 0xff,
    (payloadSize >> 8) & 0xff,
    payloadSize & 0xff,

    // packet type (0x03 == audio data)
    0x03,
    // PTS (== DTS) in 90000 Hz clock rate (48 bit unsigned integer)
    (pts / 0x10000000000) & 0xff,
    (pts / 0x100000000) & 0xff,
    (pts / 0x1000000) & 0xff,
    (pts / 0x10000) & 0xff,
    (pts / 0x100) & 0xff,
    pts & 0xff,
  ]);
  buf = Buffer.concat([buf, concatADTSFrame]);
  console.log(`send audio: pts=${pts} dts=${pts} len=${concatADTSFrame.length}`);
  try {
    return audioDataClient.write(buf);
  } catch (e) {
    return console.log(`audio write error: ${e}`);
  }
});

// Called when MPEG-TS parser recognizes PES packet in the video stream
mpegts.on('video', (pesPacket) =>
  // Pass the PES packet to H.264 parser
  h264.feedPESPacket(pesPacket),
);

// Called when MPEG-TS parser recognizes PES packet in the audio stream
mpegts.on('audio', (pesPacket) =>
  // Pass the PES packet to AAC (ADTS) parser
  aac.feedPESPacket(pesPacket),
);

// Called when no more NAL units come from H.264 parser
h264.on('end', () => {
  console.log('end of video stream');
  isVideoEnded = true;
  return checkEnd();
});

// Called when no more ADTS frames come from AAC (ADTS) parser
aac.on('end', () => {
  console.log('end of audio stream');
  isAudioEnded = true;
  return checkEnd();
});

// Called when no more PES packets come from MPEG-TS parser
mpegts.on('end', () => {
  console.log('EOF');
  h264.end();
  return aac.end();
});


// Load the MPEG-TS file
mpegts.open(INPUT_FILE); // up to 1GB

videoControlClient.start(VIDEO_CONTROL_PORT, SERVER_HOST, () =>
  audioControlClient.start(AUDIO_CONTROL_PORT, SERVER_HOST, () =>
    videoDataClient.start(VIDEO_DATA_PORT, SERVER_HOST, () =>
      audioDataClient.start(AUDIO_DATA_PORT, SERVER_HOST, () =>
        // ready to start
        sendVideoStart(() =>
          sendAudioStart(() => mpegts.startStreaming(0)),
        ),
      ),
    ),
  ),
); // skip 0 milliseconds from the start
