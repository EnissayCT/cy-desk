// Where CY Desk keeps its config and data, the same for the app, todo.js and mcp.js.
//   CY_DATA_DIR set (demo, tests)        -> config.json and data in that folder
//   a config.json next to the app        -> the developer checkout: config there, data in ./data
//   otherwise (installed app, any OS)    -> a per-user folder:
//       Windows  %APPDATA%\CY Desk
//       macOS    ~/Library/Application Support/CY Desk
//       Linux    $XDG_CONFIG_HOME/cy-desk (~/.config/cy-desk)
const fs = require('fs');
const os = require('os');
const path = require('path');

// Inside a packaged app __dirname is in app.asar: the checkout test below is false there.
const APP_DIR = path.join(__dirname, '..');

function userDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'CY Desk');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'CY Desk');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'cy-desk');
}

let CONFIG_DIR, DATA_DIR, mode;
if (process.env.CY_DATA_DIR) {
  CONFIG_DIR = DATA_DIR = process.env.CY_DATA_DIR; mode = 'custom';
} else if (fs.existsSync(path.join(APP_DIR, 'config.json')) && !APP_DIR.includes('app.asar')) {
  CONFIG_DIR = APP_DIR; DATA_DIR = path.join(APP_DIR, 'data'); mode = 'checkout';
} else {
  CONFIG_DIR = DATA_DIR = userDir(); mode = 'user';
}

module.exports = {
  APP_DIR, CONFIG_DIR, DATA_DIR, mode,
  CONFIG_FILE: path.join(CONFIG_DIR, 'config.json'),
  EXAMPLE_FILE: path.join(APP_DIR, 'config.example.json'),
  file: (name) => path.join(DATA_DIR, name)
};
