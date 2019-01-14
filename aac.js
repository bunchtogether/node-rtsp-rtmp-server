/*
 * decaffeinate suggestions:
 * DS101: Remove unnecessary use of Array.from
 * DS102: Remove unnecessary code created because of implicit returns
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
// AAC parser

const fs = require('fs');
const Bits = require('./bits');
const logger = require('./logger');

let audioBuf = null;

const MPEG_IDENTIFIER_MPEG2 = 1;
const MPEG_IDENTIFIER_MPEG4 = 0;

const eventListeners = {};

var api = {
  SYN_ID_SCE: 0x0,  // single_channel_element
  SYN_ID_CPE: 0x1,  // channel_pair_element
  SYN_ID_CCE: 0x2,  // coupling_channel_element
  SYN_ID_LFE: 0x3,  // lfe_channel_element
  SYN_ID_DSE: 0x4,  // data_stream_elemen
  SYN_ID_PCE: 0x5,  // program_config_element
  SYN_ID_FIL: 0x6,  // fill_element
  SYN_ID_END: 0x7,  // TERM

  open(file) {
    return audioBuf = fs.readFileSync(file);
  },  // up to 1GB

  close() {
    return audioBuf = null;
  },

  emit(name, ...data) {
    if (eventListeners[name] != null) {
      for (let listener of Array.from(eventListeners[name])) {
        listener(...Array.from(data || []));
      }
    }
  },

  on(name, listener) {
    if (eventListeners[name] != null) {
      return eventListeners[name].push(listener);
    } else {
      return eventListeners[name] = [ listener ];
    }
  },

  end() {
    return this.emit('end');
  },

  parseADTSHeader(buf) {
    const info = {};
    const bits = new Bits(buf);

    // adts_fixed_header()
    info.syncword = bits.read_bits(12);
    info.ID = bits.read_bit();
    info.layer = bits.read_bits(2);
    info.protection_absent = bits.read_bit();
    info.profile_ObjectType = bits.read_bits(2);
    info.sampling_frequency_index = bits.read_bits(4);
    info.private_bit = bits.read_bit();
    info.channel_configuration = bits.read_bits(3);
    info.original_copy = bits.read_bit();
    info.home = bits.read_bit();

    // adts_variable_header()
    info.copyright_identification_bit = bits.read_bit();
    info.copyright_identification_start = bits.read_bit();
    info.aac_frame_length = bits.read_bits(13);
    info.adts_buffer_fullness = bits.read_bits(11);
    info.number_of_raw_data_blocks_in_frame = bits.read_bits(2);

    return info;
  },

  // For ascInfo argument, pass a return value of readAudioSpecificConfig()
  createADTSHeader(ascInfo, aac_frame_length) {
    const bits = new Bits;
    bits.create_buf();
    // adts_fixed_header()
    bits.add_bits(12, 0xfff);  // syncword
    bits.add_bit(0);  // ID (1=MPEG-2 AAC; 0=MPEG-4)
    bits.add_bits(2, 0);  // layer
    bits.add_bit(1);  // protection_absent
    if ((ascInfo.audioObjectType - 1) > 0b11) {
      throw new Error(`invalid audioObjectType: ${ascInfo.audioObjectType} (must be <= 4)`);
    }
    bits.add_bits(2, ascInfo.audioObjectType - 1);  // profile_ObjectType
    bits.add_bits(4, ascInfo.samplingFrequencyIndex);  // sampling_frequency_index
    bits.add_bit(0);  // private_bit
    if (ascInfo.channelConfiguration > 0b111) {
      throw new Error(`invalid channelConfiguration: ${ascInfo.channelConfiguration} (must be <= 7)`);
    }
    bits.add_bits(3, ascInfo.channelConfiguration);  // channel_configuration
    bits.add_bit(0);  // original_copy
    bits.add_bit(0);  // home

    // adts_variable_header()
    bits.add_bit(0);  // copyright_identification_bit
    bits.add_bit(0);  // copyright_identification_start
    if (aac_frame_length > (8192 - 7)) {  // 7 == length of ADTS header
      throw new Error(`invalid aac_frame_length: ${aac_frame_length} (must be <= 8192)`);
    }
    bits.add_bits(13, aac_frame_length + 7);  // aac_frame_length (7 == ADTS header length)
    bits.add_bits(11, 0x7ff);  // adts_buffer_fullness (0x7ff = VBR)
    bits.add_bits(2, 0);  // number_of_raw_data_blocks_in_frame (actual - 1)

    return bits.get_created_buf();
  },

  getNextPossibleSyncwordPosition(buffer) {
    const syncwordPos = Bits.searchBitsInArray(buffer, [0xff, 0xf0], 1);
    // The maximum distance between two syncwords is 8192 bytes.
    if (syncwordPos > 8192) {
      throw new Error(`the next syncword is too far: ${syncwordPos} bytes`);
    }
    return syncwordPos;
  },

  skipToNextPossibleSyncword() {
    const syncwordPos = Bits.searchBitsInArray(audioBuf, [0xff, 0xf0], 1);
    if (syncwordPos > 0) {
      // The maximum distance between two syncwords is 8192 bytes.
      if (syncwordPos > 8192) {
        throw new Error(`the next syncword is too far: ${syncwordPos} bytes`);
      }
      logger.debug(`skipped ${syncwordPos} bytes until syncword`);
      audioBuf = audioBuf.slice(syncwordPos);
    }
  },

  splitIntoADTSFrames(buffer) {
    const adtsFrames = [];
    while (true) {
      var syncwordPos;
      if (buffer.length < 7) {
        // not enough ADTS header
        break;
      }
      if ((buffer[0] !== 0xff) || (buffer[1] & (0xf0 !== 0xf0))) {
        console.log("aac: syncword is not at current position");
        syncwordPos = this.getNextPossibleSyncwordPosition();
        buffer = buffer.slice(syncwordPos);
        continue;
      }

      const aac_frame_length = Bits.parse_bits_uint(buffer, 30, 13);
      if (buffer.length < aac_frame_length) {
        // not enough buffer
        break;
      }

      if (buffer.length >= (aac_frame_length + 2)) {
        // check next syncword
        if ((buffer[aac_frame_length] !== 0xff) ||
        (buffer[aac_frame_length+1] & (0xf0 !== 0xf0))) {  // false syncword
          console.log("aac:splitIntoADTSFrames(): syncword was false positive (emulated syncword)");
          syncwordPos = this.getNextPossibleSyncwordPosition();
          buffer = buffer.slice(syncwordPos);
          continue;
        }
      }

      const adtsFrame = buffer.slice(0, aac_frame_length);

      // Truncate audio buffer
      buffer = buffer.slice(aac_frame_length);

      adtsFrames.push(adtsFrame);
    }
    return adtsFrames;
  },

  feedPESPacket(pesPacket) {
    if (audioBuf != null) {
      audioBuf = Buffer.concat([audioBuf, pesPacket.pes.data]);
    } else {
      audioBuf = pesPacket.pes.data;
    }

    const pts = pesPacket.pes.PTS;
    const dts = pesPacket.pes.DTS;

    const adtsFrames = [];
    while (true) {
      if (audioBuf.length < 7) {
        // not enough ADTS header
        break;
      }
      if ((audioBuf[0] !== 0xff) || (audioBuf[1] & (0xf0 !== 0xf0))) {
        console.log("aac: syncword is not at current position");
        this.skipToNextPossibleSyncword();
        continue;
      }

      const aac_frame_length = Bits.parse_bits_uint(audioBuf, 30, 13);
      if (audioBuf.length < aac_frame_length) {
        // not enough buffer
        break;
      }

      if (audioBuf.length >= (aac_frame_length + 2)) {
        // check next syncword
        if ((audioBuf[aac_frame_length] !== 0xff) ||
        (audioBuf[aac_frame_length+1] & (0xf0 !== 0xf0))) {  // false syncword
          console.log("aac:feedPESPacket(): syncword was false positive (emulated syncword)");
          this.skipToNextPossibleSyncword();
          continue;
        }
      }

      const adtsFrame = audioBuf.slice(0, aac_frame_length);

      // Truncate audio buffer
      audioBuf = audioBuf.slice(aac_frame_length);

      adtsFrames.push(adtsFrame);
      this.emit('dts_adts_frame', pts, dts, adtsFrame);
    }
    if (adtsFrames.length > 0) {
      return this.emit('dts_adts_frames', pts, dts, adtsFrames);
    }
  },

  feed(data) {
    if (audioBuf != null) {
      audioBuf = Buffer.concat([audioBuf, data]);
    } else {
      audioBuf = data;
    }

    const adtsFrames = [];
    while (true) {
      if (audioBuf.length < 7) {
        // not enough ADTS header
        break;
      }
      if ((audioBuf[0] !== 0xff) || (audioBuf[1] & (0xf0 !== 0xf0))) {
        console.log("aac: syncword is not at current position");
        this.skipToNextPossibleSyncword();
        continue;
      }

      const aac_frame_length = Bits.parse_bits_uint(audioBuf, 30, 13);
      if (audioBuf.length < aac_frame_length) {
        // not enough buffer
        break;
      }

      if (audioBuf.length >= (aac_frame_length + 2)) {
        // check next syncword
        if ((audioBuf[aac_frame_length] !== 0xff) ||
        (audioBuf[aac_frame_length+1] & (0xf0 !== 0xf0))) {  // false syncword
          console.log("aac:feed(): syncword was false positive (emulated syncword)");
          this.skipToNextPossibleSyncword();
          continue;
        }
      }

      const adtsFrame = audioBuf.slice(0, aac_frame_length);

      // Truncate audio buffer
      audioBuf = audioBuf.slice(aac_frame_length);

      adtsFrames.push(adtsFrame);
      this.emit('adts_frame', adtsFrame);
    }
    if (adtsFrames.length > 0) {
      return this.emit('adts_frames', adtsFrames);
    }
  },

  hasMoreData() {
    return (audioBuf != null) && (audioBuf.length > 0);
  },

  getSampleRateFromFreqIndex(freqIndex) {
    switch (freqIndex) {
      case 0x0: return 96000;
      case 0x1: return 88200;
      case 0x2: return 64000;
      case 0x3: return 48000;
      case 0x4: return 44100;
      case 0x5: return 32000;
      case 0x6: return 24000;
      case 0x7: return 22050;
      case 0x8: return 16000;
      case 0x9: return 12000;
      case 0xa: return 11025;
      case 0xb: return 8000;
      case 0xc: return 7350;
      default: return null;
    }
  },  // escape value

  // ISO 14496-3 - Table 1.16
  getSamplingFreqIndex(sampleRate) {
    switch (sampleRate) {
      case 96000: return 0x0;
      case 88200: return 0x1;
      case 64000: return 0x2;
      case 48000: return 0x3;
      case 44100: return 0x4;
      case 32000: return 0x5;
      case 24000: return 0x6;
      case 22050: return 0x7;
      case 16000: return 0x8;
      case 12000: return 0x9;
      case 11025: return 0xa;
      case 8000: return 0xb;
      case 7350: return 0xc;
      default: return 0xf;
    }
  },  // escape value

  getChannelConfiguration(channels) {
    switch (channels) {
      case 1: return 1;
      case 2: return 2;
      case 3: return 3;
      case 4: return 4;
      case 5: return 5;
      case 6: return 6;
      case 8: return 7;
      default:
        throw new Error(`${channels} channels audio is not supported`);
    }
  },

  getChannelsByChannelConfiguration(channelConfiguration) {
    switch (channelConfiguration) {
      case 1: return 1;
      case 2: return 2;
      case 3: return 3;
      case 4: return 4;
      case 5: return 5;
      case 6: return 6;
      case 7: return 8;
      default:
        throw new Error(`Channel configuration ${channelConfiguration} is not supported`);
    }
  },

  // @param opts: {
  //   frameLength (int): 1024 or 960
  //   dependsOnCoreCoder (boolean) (optional): true if core coder is used
  //   coreCoderDelay (number) (optional): delay in samples. mandatory if
  //                                       dependsOnCoreCoder is true.
  // }
  addGASpecificConfig(bits, opts) {
    // frameLengthFlag (1 bit)
    if (opts.frameLengthFlag != null) {
      bits.add_bit(opts.frameLengthFlag);
    } else {
      if (opts.frameLength === 1024) {
        bits.add_bit(0);
      } else if (opts.frameLength === 960) {
        bits.add_bit(1);
      } else {
        throw new Error(`Invalid frameLength: ${opts.frameLength} (must be 1024 or 960)`);
      }
    }

    // dependsOnCoreCoder (1 bit)
    if (opts.dependsOnCoreCoder) {
      bits.add_bit(1);
      bits.add_bits(14, opts.coreCoderDelay);
    } else {
      bits.add_bit(0);
    }

    if (opts.extensionFlag != null) {
      return bits.add_bit(opts.extensionFlag);
    } else {
      // extensionFlag (1 bit)
      if ([1, 2, 3, 4, 6, 7].includes(opts.audioObjectType)) {
        return bits.add_bit(0);
      } else {
        throw new Error(`audio object type ${opts.audioObjectType} is not implemented`);
      }
    }
  },

  // ISO 14496-3 GetAudioObjectType()
  readGetAudioObjectType(bits) {
    let audioObjectType = bits.read_bits(5);
    if (audioObjectType === 31) {
      audioObjectType = 32 + bits.read_bits(6);
    }
    return audioObjectType;
  },

  // @param opts: {
  //   samplingFrequencyIndex: number
  //   channelConfiguration: number
  //   audioObjectType: number
  // }
  readGASpecificConfig(bits, opts) {
    const info = {};
    info.frameLengthFlag = bits.read_bit();
    info.dependsOnCoreCoder = bits.read_bit();
    if (info.dependsOnCoreCoder === 1) {
      info.coreCoderDelay = bits.read_bits(14);
    }
    info.extensionFlag = bits.read_bit();
    if (opts.channelConfiguration === 0) {
      info.program_config_element = api.read_program_config_element(bits);
    }
    if ([6, 20].includes(opts.audioObjectType)) {
      info.layerNr = bits.read_bits(3);
    }
    if (info.extensionFlag) {
      if (opts.audioObjectType === 22) {
        info.numOfSubFrame = bits.read_bits(5);
        info.layer_length = bits.read_bits(11);
      }
      if ([17, 19, 20, 23].includes(opts.audioObjectType)) {
        info.aacSectionDataResilienceFlag = bits.read_bit();
        info.aacScalefactorDataResilienceFlag = bits.read_bit();
        info.aacSpectralDataResilienceFlag = bits.read_bit();
      }
      info.extensionFlag3 = bits.read_bit();
    }
      // ISO 14496-3 says: tbd in version 3
    return info;
  },

  // ISO 14496-3 1.6.2.1 AudioSpecificConfig
  parseAudioSpecificConfig(buf) {
    const bits = new Bits(buf);
    const asc = api.readAudioSpecificConfig(bits);
    return asc;
  },

  // ISO 14496-3 1.6.2.1 AudioSpecificConfig
  readAudioSpecificConfig(bits) {
    let extensionSamplingFrequencyIndex;
    const info = {};
    info.audioObjectType = api.readGetAudioObjectType(bits);
    info.samplingFrequencyIndex = bits.read_bits(4);
    if (info.samplingFrequencyIndex === 0xf) {
      info.samplingFrequency = bits.read_bits(24);
    } else {
      info.samplingFrequency = api.getSampleRateFromFreqIndex(info.samplingFrequencyIndex);
    }
    info.channelConfiguration = bits.read_bits(4);

    info.sbrPresentFlag = -1;
    info.psPresentFlag = -1;
    info.mpsPresentFlag = -1;
    if ((info.audioObjectType === 5) || (info.audioObjectType === 29)) {
      // Explicit hierarchical signaling of SBR
      // 1.6.5.2 2.A in ISO 14496-3
      info.explicitHierarchicalSBR = true;

      info.extensionAudioObjectType = 5;
      info.sbrPresentFlag = 1;
      if (info.audioObjectType === 29) {
        info.psPresentFlag = 1;
      }
      extensionSamplingFrequencyIndex = bits.read_bits(4);
      if (extensionSamplingFrequencyIndex === 0xf) {
        info.extensionSamplingFrequency = bits.read_bits(24);
      } else {
        info.extensionSamplingFrequency = api.getSampleRateFromFreqIndex(extensionSamplingFrequencyIndex);
      }
      info.audioObjectType = api.readGetAudioObjectType(bits);
      if (info.audioObjectType === 22) {
        info.extensionChannelConfiguration = bits.read_bits(4);
      }
    } else {
      info.extensionAudioObjectType = 0;
    }

    switch (info.audioObjectType) {
      case 1: case 2: case 3: case 4: case 6: case 7: case 17: case 19: case 20: case 21: case 22: case 23:
        info.gaSpecificConfig = api.readGASpecificConfig(bits, info);
        break;
      default:
        throw new Error(`audio object type ${info.audioObjectType} is not implemented`);
    }
    switch (info.audioObjectType) {
      case 17: case 19: case 20: case 21: case 22: case 23: case 24: case 25: case 26: case 27: case 39:
        throw new Error(`audio object type ${info.audioObjectType} is not implemented`);
        break;
    }

    let extensionIdentifier = -1;
    if (bits.get_remaining_bits() >= 11) {
      extensionIdentifier = bits.read_bits(11);
    }
    if (extensionIdentifier === 0x2b7) {
      extensionIdentifier = -1;

      if ((info.extensionAudioObjectType !== 5) && (bits.get_remaining_bits() >= 5)) {
        // Explicit backward compatible signaling of SBR
        // 1.6.5.2 2.B in ISO 14496-3
        info.explicitBackwardCompatibleSBR = true;

        info.extensionAudioObjectType = api.readGetAudioObjectType(bits);
        if (info.extensionAudioObjectType === 5) {
          info.sbrPresentFlag = bits.read_bit();
          if (info.sbrPresentFlag === 1) {
            extensionSamplingFrequencyIndex = bits.read_bits(4);
            if (extensionSamplingFrequencyIndex === 0xf) {
              info.extensionSamplingFrequency = bits.read_bits(24);
            } else {
              info.extensionSamplingFrequency = api.getSampleRateFromFreqIndex(extensionSamplingFrequencyIndex);
            }
          }
          if (bits.get_remaining_bits() >= 12) {
            extensionIdentifier = bits.read_bits(11);
            if (extensionIdentifier === 0x548) {
              extensionIdentifier = -1;
              info.psPresentFlag = bits.read_bit();
            }
          }
        }
        if (info.extensionAudioObjectType === 22) {
          info.sbrPresentFlag = bits.read_bit();
          if (info.sbrPresentFlag === 1) {
            extensionSamplingFrequencyIndex = bits.read_bits(4);
            if (extensionSamplingFrequencyIndex === 0xf) {
              info.extensionSamplingFrequency = bits.read_bits(24);
            } else {
              info.extensionSamplingFrequency = api.getSampleRateFromFreqIndex(extensionSamplingFrequencyIndex);
            }
          }
          info.extensionChannelConfiguration = bits.read_bits(4);
        }
      }
    }
    if ((extensionIdentifier === -1) && (bits.get_remaining_bits() >= 11)) {
      extensionIdentifier = bits.read_bits(11);
    }
    if (extensionIdentifier === 0x76a) {
      logger.warn("aac: this audio config may not be supported (extensionIdentifier == 0x76a)");
      if ((info.audioObjectType !== 30) && (bits.get_remaining_bits() >= 1)) {
        info.mpsPresentFlag = bits.read_bit();
        if (info.mpsPresentFlag === 1) {
          info.sacPayloadEmbedding = 1;
          info.sscLen = bits.read_bits(8);
          if (info.sscLen === 0xff) {
            const sscLenExt = bits.read_bits(16);
            info.sscLen += sscLenExt;
          }
          info.spatialSpecificConfig = api.readSpatialSpecificConfig(bits);
        }
      }
    }

    return info;
  },

  readSpatialSpecificConfig(bits) {
    throw new Error("SpatialSpecificConfig is not implemented");
  },

  // Inverse of GetAudioObjectType() in ISO 14496-3 Table 1.14
  addAudioObjectType(bits, audioObjectType) {
    if (audioObjectType >= 32) {
      bits.add_bits(5, 31);  // 0b11111
      return bits.add_bits(6, audioObjectType - 32);
    } else {
      return bits.add_bits(5, audioObjectType);
    }
  },

  // @param opts: A return value of parseAudioSpecificConfig(), or an object: {
  //   audioObjectType (int): audio object type
  //   samplingFrequency (int): sample rate in Hz
  //   extensionSamplingFrequency (int) (optional): sample rate in Hz for extension
  //   channels (int): number of channels
  //   extensionChannels (int): number of channels for extension
  //   frameLength (int): 1024 or 960
  // }
  createAudioSpecificConfig(opts, explicitHierarchicalSBR) {
    let audioObjectType, channelConfiguration;
    if (explicitHierarchicalSBR == null) { explicitHierarchicalSBR = false; }
    const bits = new Bits;
    bits.create_buf();

    // Table 1.13 - AudioSpecificConfig()

    if ((opts.sbrPresentFlag === 1) && explicitHierarchicalSBR) {
      if (opts.psPresentFlag === 1) {
        audioObjectType = 29; // HE-AAC v2
      } else {
        audioObjectType = 5;  // HE-AAC v1
      }
    } else {
      ({ audioObjectType } = opts);
    }

    api.addAudioObjectType(bits, audioObjectType);

    let samplingFreqIndex = api.getSamplingFreqIndex(opts.samplingFrequency);
    bits.add_bits(4, samplingFreqIndex);
    if (samplingFreqIndex === 0xf) {
      bits.add_bits(24, opts.samplingFrequency);
    }
    if (opts.channelConfiguration != null) {
      bits.add_bits(4, opts.channelConfiguration);
    } else {
      channelConfiguration = api.getChannelConfiguration(opts.channels);
      bits.add_bits(4, channelConfiguration);
    }

    if ((opts.sbrPresentFlag === 1) && explicitHierarchicalSBR) {
      // extensionSamplingFrequencyIndex
      samplingFreqIndex = api.getSamplingFreqIndex(opts.extensionSamplingFrequency);
      bits.add_bits(4, samplingFreqIndex);
      if (samplingFreqIndex === 0xf) {
        // extensionSamplingFrequency
        bits.add_bits(24, opts.extensionSamplingFrequency);
      }
      api.addAudioObjectType(bits, opts.audioObjectType);
      if (opts.audioObjectType === 22) {
        if (opts.channelConfiguration != null) {
          bits.add_bits(4, opts.channelConfiguration);
        } else {
          channelConfiguration = api.getChannelConfiguration(opts.extensionChannels);
          bits.add_bits(4, channelConfiguration);
        }
      }
    }

    switch (opts.audioObjectType) {
      case 1: case 2: case 3: case 4: case 6: case 7: case 17: case 19: case 20: case 21: case 22: case 23:
        if (opts.gaSpecificConfig != null) {
          api.addGASpecificConfig(bits, opts.gaSpecificConfig);
        } else {
          api.addGASpecificConfig(bits, opts);
        }
        break;
      default:
        throw new Error(`audio object type ${opts.audioObjectType} is not implemented`);
    }
    switch (opts.audioObjectType) {
      case 17: case 19: case 20: case 21: case 22: case 23: case 24: case 25: case 26: case 27: case 39:
        throw new Error(`audio object type ${opts.audioObjectType} is not implemented`);
        break;
    }

    if ((opts.sbrPresentFlag === 1) && (!explicitHierarchicalSBR)) {
      // extensionIdentifier
      bits.add_bits(11, 0x2b7);

      if (opts.audioObjectType !== 22) {
        // extensionAudioObjectType
        api.addAudioObjectType(bits, 5);

        // sbrPresentFlag
        bits.add_bit(1);

        samplingFreqIndex = api.getSamplingFreqIndex(opts.extensionSamplingFrequency);
        // extensionSamplingFrequencyIndex
        bits.add_bits(4, samplingFreqIndex);
        if (samplingFreqIndex === 0xf) {
          // extensionSamplingFrequency
          bits.add_bits(24, opts.extensionSamplingFrequency);
        }

        if (opts.psPresentFlag === 1) {
          // extensionIdentifier
          bits.add_bits(11, 0x548);
          // psPresentFlag
          bits.add_bit(1);
        }
      } else {  // opts.audioObjectType is 22
        // extensionAudioObjectType
        api.addAudioObjectType(bits, 22);
        // sbrPresentFlag
        bits.add_bit(1);

        samplingFreqIndex = api.getSamplingFreqIndex(opts.extensionSamplingFrequency);
        // extensionSamplingFrequencyIndex
        bits.add_bits(4, samplingFreqIndex);
        if (samplingFreqIndex === 0xf) {
          // extensionSamplingFrequency
          bits.add_bits(24, opts.extensionSamplingFrequency);
        }

        // extensionChannelConfiguration
        if (opts.extensionChannelConfiguration != null) {
          bits.add_bits(4, opts.extensionChannelConfiguration);
        } else {
          channelConfiguration = api.getChannelConfiguration(opts.extensionChannels);
          bits.add_bits(4, channelConfiguration);
        }
      }
    }

    return bits.get_created_buf();
  },

  parseADTSFrame(adtsFrame) {
    const info = {};

    if ((adtsFrame[0] !== 0xff) || (adtsFrame[1] & (0xf0 !== 0xf0))) {
      throw new Error("malformed audio: data doesn't start with a syncword (0xfff)");
    }

    info.mpegIdentifier = Bits.parse_bits_uint(adtsFrame, 12, 1);
    const profile_ObjectType = Bits.parse_bits_uint(adtsFrame, 16, 2);
    if (info.mpegIdentifier === MPEG_IDENTIFIER_MPEG2) {
      info.audioObjectType = profile_ObjectType;
    } else {
      info.audioObjectType = profile_ObjectType + 1;
    }
    const freq = Bits.parse_bits_uint(adtsFrame, 18, 4);
    info.sampleRate = api.getSampleRateFromFreqIndex(freq);
    info.channels = Bits.parse_bits_uint(adtsFrame, 23, 3);

//    # raw_data_block starts from byte index 7
//    id_syn_ele = Bits.parse_bits_uint adtsFrame, 56, 3

    return info;
  },

  getNextADTSFrame() {
    if ((audioBuf == null)) {
      throw new Error("aac error: file is not opened yet");
    }

    while (true) {
      if (!api.hasMoreData()) {
        return null;
      }

      if ((audioBuf[0] !== 0xff) || (audioBuf[1] & (0xf0 !== 0xf0))) {
        console.log("aac: syncword is not at current position");
        this.skipToNextPossibleSyncword();
        continue;
      }

      const aac_frame_length = Bits.parse_bits_uint(audioBuf, 30, 13);
      if (audioBuf.length < aac_frame_length) {
        // not enough buffer
        return null;
      }

      if (audioBuf.length >= (aac_frame_length + 2)) {
        // check next syncword
        if ((audioBuf[aac_frame_length] !== 0xff) ||
        (audioBuf[aac_frame_length+1] & (0xf0 !== 0xf0))) {  // false syncword
          console.log("aac:getNextADTSFrame(): syncword was false positive (emulated syncword)");
          this.skipToNextPossibleSyncword();
          continue;
        }
      }

      const adtsFrame = audioBuf.slice(0, aac_frame_length);

      // Truncate audio buffer
      audioBuf = audioBuf.slice(aac_frame_length);

      return adtsFrame;
    }
  }
};

module.exports = api;
