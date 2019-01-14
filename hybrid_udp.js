/* eslint-disable
    consistent-return,
    no-constant-condition,
    no-param-reassign,
    no-return-assign,
    no-shadow,
    no-undef,
    no-underscore-dangle,
    no-unused-vars,
    no-var,
    one-var,
    prefer-rest-params,
    vars-on-top,
*/
// TODO: This file was created by bulk-decaffeinate.
// Fix any style issues and re-enable lint.
/*
 * decaffeinate suggestions:
 * DS102: Remove unnecessary code created because of implicit returns
 * DS202: Simplify dynamic range loops
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
// Hybrid UDP
// - can send fire-and-forget (unreliable) packet
// - can send reliable packet which requires ACK

/*
* Usage

    hybrid_udp = require './hybrid_udp'

    server = new hybrid_udp.UDPServer
    server.on 'packet', (buf, addr, port) ->
      * buf is a Buffer instance
      console.log "server received: 0x#{buf.toString 'hex'}"
      if buf[0] is 0x04
        * shutdown server
        server.stop()
        console.log "server stopped"
    server.start 9999, "localhost", ->
      console.log "server started"

      client = new hybrid_udp.UDPClient
      client.start 9999, "localhost", ->
        console.log "client started"
        console.log "client: writing 0x010203"
        client.write new Buffer([0x01, 0x02, 0x03]), ->
          console.log "client: writing 0x040506 and waiting for ACK"
          client.writeReliable new Buffer([0x04, 0x05, 0x06]), ->
            console.log "client: received ACK"
            client.stop()
            console.log "client stopped"
*/

let UDPClient,
  UDPServer;
const events = require('events');
const dgram = require('dgram');

const logger = require('./logger');

const MAX_PACKET_ID = 255;
const FRAGMENT_HEADER_LEN = 2;

const RESEND_TIMEOUT = 100; // ms

const PACKET_TYPE_UNRELIABLE = 0x01;
const PACKET_TYPE_REQUIRE_ACK = 0x02;
const PACKET_TYPE_ACK = 0x03;
const PACKET_TYPE_RESET = 0x04;

const OLD_UDP_PACKET_TIME_THRESHOLD = 1000;

const RECEIVE_PACKET_ID_WINDOW = 10;

const INITIAL_PACKET_ID = 0;

const zeropad = function (width, num) {
  num += '';
  while (num.length < width) {
    num = `0${num}`;
  }
  return num;
};

exports.UDPClient = (UDPClient = class UDPClient {
  constructor() {
    this.pendingPackets = [];
    this.newPacketId = 0;
    this.maxPacketSize = 8000; // good for LAN?
    //    @maxPacketSize = 1472  # good for internet
    this.isInBlockMode = false;
    this.ackCallbacks = {};
    this.serverPort = null;
    this.serverHost = null;
    this.isStopped = false;

    this.socket = dgram.createSocket('udp4');

    this.socket.on('error', function (err) {
      logger.error(`UDPServer socket error: ${err}`);
      return this.socket.close();
    });

    this.socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
  }

  start(serverPort, serverHost, callback) {
    this.serverPort = serverPort;
    this.serverHost = serverHost;
    // bind to any available port
    return this.socket.bind(0, '0.0.0.0', () => this.resetPacketId(callback));
  }

  stop() {
    this.isStopped = true;
    return this.socket.close();
  }

  onMessage(msg, rinfo) {
    const packetType = msg[0];
    if (packetType === PACKET_TYPE_ACK) {
      const packetId = msg[1];
      if (this.ackCallbacks[packetId] != null) {
        return this.ackCallbacks[packetId]();
      }
      return logger.warn(`ACK is already processed for packetId ${packetId}`);
    }
    logger.warn(`unknown packet type: ${packetType} len=${msg.length}`);
    return logger.warn(msg);
  }

  getNextPacketId() {
    const id = this.newPacketId;
    if (++this.newPacketId > MAX_PACKET_ID) {
      this.newPacketId = 0;
    }
    return id;
  }

  sendPacket(packetType, packetId, buf, callback) {
    const sendData = new Buffer(this.maxPacketSize);
    sendData[0] = packetType;
    sendData[1] = packetId;

    const fragmentSize = this.maxPacketSize - FRAGMENT_HEADER_LEN - 2;
    if (fragmentSize <= 0) {
      throw new Error(`maxPacketSize must be > ${FRAGMENT_HEADER_LEN + 2}`);
    }
    const bufLen = buf.length;
    const totalFragments = Math.ceil(bufLen / fragmentSize);
    // maximum number of fragments is 256
    if (totalFragments > 256) {
      throw new Error(`too many fragments: ${totalFragments} (buf.length=${bufLen} / fragmentSize=${fragmentSize})`);
    }
    const endFragmentNumber = totalFragments - 1;
    sendData[2] = endFragmentNumber;

    let fragmentNumber = 0;
    let wroteLen = 0;
    let sentCount = 0;

    var sendNextFragment = () => {
      let thisLen;
      if (wroteLen >= bufLen) {
        throw new Error(`wroteLen (${wroteLen}) > bufLen (${bufLen})`);
      }
      const remainingLen = bufLen - wroteLen;
      if (remainingLen < fragmentSize) {
        thisLen = remainingLen;
      } else {
        thisLen = fragmentSize;
      }
      sendData[3] = fragmentNumber;
      buf.copy(sendData, 4, wroteLen, wroteLen + thisLen);
      fragmentNumber++;
      return this.socket.send(sendData, 0, thisLen + 4, this.serverPort, this.serverHost, () => {
        wroteLen += thisLen;
        sentCount++;
        if (sentCount === totalFragments) {
          return (typeof callback === 'function' ? callback() : undefined);
        }
        return sendNextFragment();
      });
    };

    return sendNextFragment();
  }

  resetPacketId(callback) {
    const buf = new Buffer([
      // packet type
      PACKET_TYPE_RESET,
      // packet id
      INITIAL_PACKET_ID,
    ]);
    this.newPacketId = INITIAL_PACKET_ID + 1;

    let isACKReceived = false;

    // wait until receives ack
    this.waitForACK(INITIAL_PACKET_ID, () => {
      isACKReceived = true;
      return (typeof callback === 'function' ? callback() : undefined);
    });

    // send
    this.socket.send(buf, 0, buf.length, this.serverPort, this.serverHost);

    return setTimeout(() => {
      if (!isACKReceived && !this.isStopped) {
        logger.warn('resend reset (no ACK received)');
        return this.resetPacketId(callback);
      }
    }
      , RESEND_TIMEOUT);
  }

  rawSend(buf, offset, length, callback) {
    return this.socket.send(buf, offset, length, this.serverPort, this.serverAddress, callback);
  }

  write(buf, callback) {
    if (this.isInBlockMode) {
      this.pendingPackets.push([this.write, ...arguments]);
      return;
    }

    const packetId = this.getNextPacketId();
    return this.sendPacket(PACKET_TYPE_UNRELIABLE, packetId, buf, callback);
  }

  _writeReliableBypassBlock(buf, packetId, onSuccessCallback, onTimeoutCallback) {
    let isACKReceived = false;

    // wait until receives ack
    this.waitForACK(packetId, () => {
      isACKReceived = true;
      return (typeof onSuccessCallback === 'function' ? onSuccessCallback() : undefined);
    });

    // send
    this.sendPacket(PACKET_TYPE_REQUIRE_ACK, packetId, buf);

    return setTimeout(() => {
      if (!isACKReceived && !this.isStopped) {
        logger.warn(`resend ${packetId} (no ACK received)`);
        return onTimeoutCallback();
      }
    }
      , RESEND_TIMEOUT);
  }

  _writeReliable(buf, packetId, callback) {
    if (this.isInBlockMode) {
      this.pendingPackets.push([this._writeReliable, ...arguments]);
      // TODO: limit maximum number of pending packets
      return;
    }

    return this._writeReliableBypassBlock(buf, packetId, callback, () => this._writeReliable(buf, packetId, callback));
  }

  writeReliable(buf, callback) {
    const packetId = this.getNextPacketId();
    return this._writeReliable(buf, packetId, callback);
  }

  waitForACK(packetId, callback) {
    return this.ackCallbacks[packetId] = () => {
      delete this.ackCallbacks[packetId];
      return (typeof callback === 'function' ? callback() : undefined);
    };
  }

  flushPendingPackets(callback) {
    if (this.pendingPackets.length === 0) {
      if (typeof callback === 'function') {
        callback();
      }
      return;
    }

    const packet = this.pendingPackets.shift();
    const func = packet[0];
    const args = packet.slice(1);
    const origCallback = args[func.length - 1];
    args[func.length - 1] = () => {
      this.flushPendingPackets(callback);
      return (typeof origCallback === 'function' ? origCallback() : undefined);
    };
    return func.apply(this, args);
  }

  _writeReliableBlocked(buf, packetId, callback) {
    return this._writeReliableBypassBlock(buf, packetId, callback, () => this._writeReliableBlocked(buf, packetId, callback));
  }

  // Defer other packets until this packet is received
  writeReliableBlocked(buf, callback) {
    if (this.isInBlockMode) {
      this.pendingPackets.push([this.writeReliableBlocked, ...arguments]);
      return;
    }

    this.isInBlockMode = true;

    const packetId = this.getNextPacketId();
    return this._writeReliableBlocked(buf, packetId, () => {
      this.isInBlockMode = false;
      return this.flushPendingPackets(callback);
    });
  }

  fragment(buf, fragmentSize) {
    if (fragmentSize == null) { fragmentSize = maxPacketSize; }
    const fragments = [];
    const remainingLen = buf.length;
    while (remainingLen > 0) {
      var thisLen;
      if (remainingLen < fragmentSize) {
        thisLen = remainingLen;
      } else {
        thisLen = fragmentSize;
      }
      fragments.push(buf.slice(0, thisLen));
      buf = buf.slice(thisLen);
    }
    return fragments;
  }
});

exports.UDPServer = (UDPServer = class UDPServer extends events.EventEmitter {
  constructor() {
    super();
    this.socket = dgram.createSocket('udp4');

    this.socket.on('error', function (err) {
      logger.error(`UDPServer socket error: ${err}`);
      return this.socket.close();
    });

    this.socket.on('message', (msg, rinfo) => this.onReceiveMessage(msg, rinfo));

    this.isStopped = false;
    this.resetServerState();
  }

  resetServerState() {
    this.videoReceiveBuf = {};
    this.processedPacketId = null;
    this.latestPacketId = null;
    this.bufferedPackets = {};
    return this.packetLastReceiveTime = {};
  }

  onReceiveMessage(msg, rinfo) {
    let receivedBuf;
    const packetType = msg[0];
    const packetId = msg[1];
    const endFragmentNumber = msg[2];
    const fragmentNumber = msg[3];

    if (packetType === PACKET_TYPE_RESET) {
      this.resetServerState();
      this.latestPacketId = packetId;
      this.processedPacketId = packetId;
      this.sendAck(packetId, rinfo.port, rinfo.address);
      return;
    }

    this.packetLastReceiveTime[packetId] = Date.now();

    if (this.latestPacketId != null) {
      if (((packetId <= (this.latestPacketId + RECEIVE_PACKET_ID_WINDOW)) &&
      (packetId > this.latestPacketId)) ||
      (packetId < (this.latestPacketId - 50))) {
        this.latestPacketId = packetId;
      }
    } else {
      this.latestPacketId = packetId;
    }

    if (endFragmentNumber > 0) { // fragmentation
      if (this.videoReceiveBuf[packetId] != null) {
        // check if existing packet is too old
        if ((Date.now() - this.videoReceiveBuf[packetId].time) >= OLD_UDP_PACKET_TIME_THRESHOLD) {
          logger.warn(`drop stale buffer of packetId ${packetId}`);
          this.videoReceiveBuf[packetId] = null;
        }
      }
      if ((this.videoReceiveBuf[packetId] == null)) {
        this.videoReceiveBuf[packetId] = {
          buf: [],
          totalReceivedLength: 0,
        };
      }
      const targetBuf = this.videoReceiveBuf[packetId];
      targetBuf.buf[fragmentNumber] = msg.slice(4);
      targetBuf.time = Date.now();
      targetBuf.totalReceivedLength += msg.length - 4;
      let isMissing = false;
      for (let i = 0, end = endFragmentNumber, asc = end >= 0; asc ? i <= end : i >= end; asc ? i++ : i--) {
        if ((targetBuf.buf[i] == null)) {
          isMissing = true;
          break;
        }
      }
      if (!isMissing) { // received all fragments
        try {
          receivedBuf = Buffer.concat(targetBuf.buf);
          return this.onReceivePacket({
            packetType,
            packetId,
            port: rinfo.port,
            address: rinfo.address,
            body: receivedBuf,
          });
        } catch (e) {
          logger.error(`concat/receive error for packetId=${packetId}: ${e}`);
          logger.error(e.stack);
          return logger.error(targetBuf.buf);
        } finally {
          delete this.videoReceiveBuf[packetId];
          delete this.packetLastReceiveTime[packetId];
        }
      }
    } else { // no fragmentation
      receivedBuf = msg.slice(4);
      delete this.videoReceiveBuf[packetId];
      delete this.packetLastReceiveTime[packetId];
      return this.onReceivePacket({
        packetType,
        packetId,
        port: rinfo.port,
        address: rinfo.address,
        body: receivedBuf,
      });
    }
  }

  consumeBufferedPacketsFrom(packetId) {
    const oldEnoughTime = Date.now() - OLD_UDP_PACKET_TIME_THRESHOLD;
    while (true) {
      if ((this.bufferedPackets[packetId] == null)) {
        break;
      }
      if (this.packetLastReceiveTime[packetId] <= oldEnoughTime) {
        logger.warn(`packet ${packetId} is too old`);
        break;
      }
      this.onCompletePacket(this.bufferedPackets[packetId]);
      delete this.bufferedPackets[packetId];
      this.processedPacketId = packetId;
      if (packetId === MAX_PACKET_ID) {
        packetId = 0;
      } else {
        packetId++;
      }
    }
  }

  deleteOldBufferedPackets() {
    let oldestUnprocessedPacketId;
    if (this.processedPacketId === this.latestPacketId) {
      return;
    }

    let isDoneSomething = false;
    if (this.processedPacketId === MAX_PACKET_ID) {
      oldestUnprocessedPacketId = 0;
    } else {
      oldestUnprocessedPacketId = this.processedPacketId + 1;
    }
    const oldEnoughTime = Date.now() - OLD_UDP_PACKET_TIME_THRESHOLD;
    for (let packetId = oldestUnprocessedPacketId, end = this.latestPacketId, asc = oldestUnprocessedPacketId <= end; asc ? packetId < end : packetId > end; asc ? packetId++ : packetId--) {
      if ((this.packetLastReceiveTime[packetId] == null)) {
        this.packetLastReceiveTime[packetId] = Date.now();
      }
      if (this.packetLastReceiveTime[packetId] <= oldEnoughTime) {
        // Failed to receive a packet
        const timeDiff = oldEnoughTime - this.packetLastReceiveTime[packetId];
        logger.warn(`dropped packet ${packetId}: ${timeDiff} ms late`);
        isDoneSomething = true;
        if (this.bufferedPackets[packetId] != null) {
          delete this.bufferedPackets[packetId];
        }
        if (this.processedPacketId === MAX_PACKET_ID) {
          this.processedPacketId = 0;
        } else {
          this.processedPacketId++;
        }
      } else {
        break;
      }
    }
    if (isDoneSomething) {
      let nextPacketId;
      if (this.processedPacketId === MAX_PACKET_ID) {
        nextPacketId = 0;
      } else {
        nextPacketId = this.processedPacketId + 1;
      }
      this.consumeBufferedPacketsFrom(nextPacketId);
    }
  }

  onReceivePacket(packet) {
    let anticipatingPacketId = this.processedPacketId + 1;
    if (anticipatingPacketId === (MAX_PACKET_ID + 1)) {
      anticipatingPacketId = 0;
    }
    if (packet.packetId === anticipatingPacketId) { // continuous
      let nextPacketId;
      this.processedPacketId = packet.packetId;
      this.onCompletePacket(packet);
      if (packet.packetId === MAX_PACKET_ID) {
        nextPacketId = 0;
      } else {
        nextPacketId = packet.packetId + 1;
      }
      return this.consumeBufferedPacketsFrom(nextPacketId);
    } // non-continuous
    if (this.processedPacketId - RECEIVE_PACKET_ID_WINDOW <= packet.packetId && packet.packetId <= this.processedPacketId) {
      logger.warn(`duplicated packet ${packet.packetId}`);
      if (packet.packetType === PACKET_TYPE_REQUIRE_ACK) {
        this.sendAck(packet.packetId, packet.port, packet.address);
      }
      return;
    }
    this.bufferedPackets[packet.packetId] = packet;
    return this.deleteOldBufferedPackets();
  }

  onCompletePacket(packet) {
    if (packet.packetType === PACKET_TYPE_REQUIRE_ACK) {
      this.sendAck(packet.packetId, packet.port, packet.address);
    }

    return setTimeout(() => this.emit('packet', packet.body, packet.address, packet.port)
      , 0);
  }

  sendAck(packetId, port, address, callback) {
    const buf = new Buffer([
      // packet type
      PACKET_TYPE_ACK,
      // packet id
      packetId,
    ]);
    return this.socket.send(buf, 0, buf.length, port, address, callback);
  }

  start(port, address, callback) {
    return this.socket.bind(port, address, callback);
  }

  stop() {
    this.isStopped = true;
    return this.socket.close();
  }
});
