/*
 * decaffeinate suggestions:
 * DS102: Remove unnecessary code created because of implicit returns
 * DS202: Simplify dynamic range loops
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
// RTMP handshake

const crypto = require('crypto');
const codec_utils = require('./codec_utils');
const logger = require('./logger');

const MESSAGE_FORMAT_1       =  1;
const MESSAGE_FORMAT_2       =  2;
const MESSAGE_FORMAT_UNKNOWN = -1;

const RTMP_SIG_SIZE = 1536;
const SHA256DL = 32;  // SHA256 digest length (bytes)

const KEY_LENGTH = 128;

const RandomCrud = new Buffer([
    0xf0, 0xee, 0xc2, 0x4a,
    0x80, 0x68, 0xbe, 0xe8, 0x2e, 0x00, 0xd0, 0xd1,
    0x02, 0x9e, 0x7e, 0x57, 0x6e, 0xec, 0x5d, 0x2d,
    0x29, 0x80, 0x6f, 0xab, 0x93, 0xb8, 0xe6, 0x36,
    0xcf, 0xeb, 0x31, 0xae
]);

const GenuineFMSConst = "Genuine Adobe Flash Media Server 001";
const GenuineFMSConstCrud = Buffer.concat([new Buffer(GenuineFMSConst, "utf8"), RandomCrud]);

const GenuineFPConst  = "Genuine Adobe Flash Player 001";
const GenuineFPConstCrud = Buffer.concat([new Buffer(GenuineFPConst, "utf8"), RandomCrud]);

const GetClientGenuineConstDigestOffset = function(buf) {
  let offset = buf[0] + buf[1] + buf[2] + buf[3];
  offset = (offset % 728) + 12;
  return offset;
};

const GetServerGenuineConstDigestOffset = function(buf) {
  let offset = buf[0] + buf[1] + buf[2] + buf[3];
  offset = (offset % 728) + 776;
  return offset;
};

const GetClientDHOffset = function(buf) {
  let offset = buf[0] + buf[1] + buf[2] + buf[3];
  offset = (offset % 632) + 772;
  return offset;
};

const GetServerDHOffset = function(buf) {
  let offset = buf[0] + buf[1] + buf[2] + buf[3];
  offset = (offset % 632) + 8;
  return offset;
};

const hasSameBytes = function(buf1, buf2) {
  for (let i = 0, end = buf1.length, asc = 0 <= end; asc ? i < end : i > end; asc ? i++ : i--) {
    if (buf1[i] !== buf2[i]) {
      return false;
    }
  }
  return true;
};

const detectClientMessageFormat = function(clientsig) {
  let sdl = GetServerGenuineConstDigestOffset(clientsig.slice(772, 776));
  let msg = Buffer.concat([clientsig.slice(0, sdl), clientsig.slice(sdl+SHA256DL)], 1504);
  let computedSignature = codec_utils.calcHmac(msg, GenuineFPConst);
  let providedSignature = clientsig.slice(sdl, sdl+SHA256DL);
  if (hasSameBytes(computedSignature, providedSignature)) {
    return MESSAGE_FORMAT_2;
  }

  sdl = GetClientGenuineConstDigestOffset(clientsig.slice(8, 12));
  msg = Buffer.concat([clientsig.slice(0, sdl), clientsig.slice(sdl+SHA256DL)], 1504);
  computedSignature = codec_utils.calcHmac(msg, GenuineFPConst);
  providedSignature = clientsig.slice(sdl, sdl+SHA256DL);
  if (hasSameBytes(computedSignature, providedSignature)) {
    return MESSAGE_FORMAT_1;
  }

  return MESSAGE_FORMAT_UNKNOWN;
};

const DHKeyGenerate = function(bits) {
  const dh = crypto.getDiffieHellman('modp2');
  dh.generateKeys();
  return dh;
};

const generateS1 = (messageFormat, dh, callback) =>
  crypto.pseudoRandomBytes(RTMP_SIG_SIZE - 8, function(err, randomBytes) {
    let serverDHOffset, serverDigestOffset;
    const handshakeBytes = Buffer.concat([
      new Buffer([ 0, 0, 0, 0, 1, 2, 3, 4 ]),
      randomBytes
    ], RTMP_SIG_SIZE);
    if (messageFormat === 1) {
      serverDHOffset = GetClientDHOffset(handshakeBytes.slice(1532, 1536));
    } else {
      serverDHOffset = GetServerDHOffset(handshakeBytes.slice(768, 772));
    }

    const publicKey = dh.getPublicKey();
    publicKey.copy(handshakeBytes, serverDHOffset, 0, publicKey.length);

    if (messageFormat === 1) {
      serverDigestOffset = GetClientGenuineConstDigestOffset(handshakeBytes.slice(8, 12));
    } else {
      serverDigestOffset = GetServerGenuineConstDigestOffset(handshakeBytes.slice(772, 776));
    }
    const msg = Buffer.concat([
      handshakeBytes.slice(0, serverDigestOffset),
      handshakeBytes.slice(serverDigestOffset+SHA256DL)
    ], RTMP_SIG_SIZE - SHA256DL);
    const hash = codec_utils.calcHmac(msg, GenuineFMSConst);
    hash.copy(handshakeBytes, serverDigestOffset, 0, 32);
    return callback(null, handshakeBytes);
  })
;

const generateS2 = function(messageFormat, clientsig, callback) {
  let challengeKeyOffset, keyOffset;
  if (messageFormat === 1) {
    challengeKeyOffset = GetClientGenuineConstDigestOffset(clientsig.slice(8, 12));
  } else {
    challengeKeyOffset = GetServerGenuineConstDigestOffset(clientsig.slice(772, 776));
  }
  const challengeKey = clientsig.slice(challengeKeyOffset, +(challengeKeyOffset+31) + 1 || undefined);

  if (messageFormat === 1) {
    keyOffset = GetClientDHOffset(clientsig.slice(1532, 1536));
  } else {
    keyOffset = GetServerDHOffset(clientsig.slice(768, 772));
  }
  const key = clientsig.slice(keyOffset, keyOffset+KEY_LENGTH);

  const hash = codec_utils.calcHmac(challengeKey, GenuineFMSConstCrud);
  return crypto.pseudoRandomBytes(RTMP_SIG_SIZE - 32, function(err, randomBytes) {
    const signature = codec_utils.calcHmac(randomBytes, hash);
    const s2Bytes = Buffer.concat([
      randomBytes, signature
    ], RTMP_SIG_SIZE);
    return callback(null, s2Bytes,
      {clientPublicKey: key});
  });
};

// Generate S0/S1/S2 combined message
const generateS0S1S2 = function(clientsig, callback) {
  const clientType = clientsig[0];
  clientsig = clientsig.slice(1);

  const dh = DHKeyGenerate(KEY_LENGTH * 8);

  let messageFormat = detectClientMessageFormat(clientsig);
  if (messageFormat === MESSAGE_FORMAT_UNKNOWN) {
    logger.warn("[rtmp:handshake] warning: unknown message format, assuming format 1");
    messageFormat = 1;
  }
  return generateS1(messageFormat, dh, (err, s1Bytes) =>
    generateS2(messageFormat, clientsig, function(err, s2Bytes, keys) {
      const allBytes = Buffer.concat([
        new Buffer([ clientType ]),  // version (S0)
        s1Bytes,  // S1
        s2Bytes   // S2
      ], 3073);
      keys.dh = dh;
      return callback(null, allBytes, keys);
    })
  );
};

module.exports =
  {generateS0S1S2};
