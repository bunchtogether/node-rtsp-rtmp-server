/*
 * decaffeinate suggestions:
 * DS209: Avoid top-level return
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
const mp4 = require('../mp4');

const getCurrentTime = function() {
  const time = process.hrtime();
  return time[0] + (time[1] / 1e9);
};

if (process.argv.length < 3) {
  console.log("Error: specify an mp4 filename");
  return 1;
}

const mp4file = new mp4.MP4File(process.argv[2]);
mp4file.parse();
mp4file.dump();
