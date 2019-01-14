const { addShutdownHandler, addPostShutdownHandler } = require('@bunchtogether/exit-handler');
const server = require('./server');

async function init() { // eslint-disable-line no-shadow
  console.log('Starting RTSP server...');
  await server.start();

  addShutdownHandler(async () => {
    await server.stop();
  }, (error) => {
    if (error.stack) {
      console.error('Error during shutdown:');
      error.stack.split('\n').forEach((line) => console.error(`\t${line.trim()}`));
    } else {
      console.error(`Error during shutdown: ${error.message}`);
    }
  });

  addPostShutdownHandler(() => {
    console.log('Shutting down RTSP server...');
    process.exit(0);
  });
}

init().catch((error) => {
  console.error(error.stack);
  process.exit(1);
});
