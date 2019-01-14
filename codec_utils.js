const crypto = require('crypto');

module.exports = {
  // Calculate the digest of data and return a buffer
  calcHmac(data, key) {
    const hmac = crypto.createHmac('sha256', key);
    hmac.update(data);
    return hmac.digest();
  }
};
