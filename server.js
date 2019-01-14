/*
 * decaffeinate suggestions:
 * DS102: Remove unnecessary code created because of implicit returns
 * DS103: Rewrite code to no longer use __guard__
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
const url = require('url');

const config = require('./config');
const StreamServer = require('./stream_server');
const Bits = require('./bits');
const logger = require('./logger');

Bits.set_warning_fatal(true);
logger.setLevel(logger.LEVEL_INFO);

const streamServer = new StreamServer;

// Uncomment this block if you use Basic auth for RTSP
//streamServer.setAuthenticator (username, password, callback) ->
//  # If isAuthenticated is true, access is allowed
//  isAuthenticated = false
//
//  # Replace here
//  if (username is 'user1') and (password is 'password1')
//    isAuthenticated = true
//
//  callback null, isAuthenticated

streamServer.setLivePathConsumer(function(uri, callback) {
  const pathname = __guard__(url.parse(uri).pathname, x => x.slice(1));

  const isAuthorized = true;

  if (isAuthorized) {
    return callback(null); // Accept access
  } else {
    return callback(new Error('Unauthorized access'));
  }
}); // Deny access

if (config.recordedDir != null) {
  streamServer.attachRecordedDir(config.recordedDir);
}

process.on('SIGINT', () => {
  console.log('Got SIGINT');
  return streamServer.stop(() => process.kill(process.pid, 'SIGTERM'));
});

process.on('uncaughtException', function(err) {
  streamServer.stop();
  throw err;
});

streamServer.start();

function __guard__(value, transform) {
  return (typeof value !== 'undefined' && value !== null) ? transform(value) : undefined;
}