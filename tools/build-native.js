// Builds native/audiometer.exe with the C# compiler that ships with Windows (.NET Framework 4).
// Runs after `npm install`; does nothing elsewhere or when the compiler is missing.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.platform !== 'win32') process.exit(0);
const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const src = path.join(__dirname, '..', 'native', 'audiometer.cs');
const out = path.join(__dirname, '..', 'native', 'audiometer.exe');
if (!fs.existsSync(csc)) { console.log('build-native: C# compiler not found, Cy will not sing (everything else works).'); process.exit(0); }
try {
  execFileSync(csc, ['/nologo', '/optimize', `/out:${out}`, src], { stdio: 'inherit' });
  console.log('build-native: native/audiometer.exe ready');
} catch (e) {
  console.log('build-native: failed, Cy will not sing (everything else works).');
}
