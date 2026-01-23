const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '../node_modules/telegraf/lib/core/network/client.js');
let content = fs.readFileSync(file, 'utf8');

const oldCode = `function redactToken(error) {
    error.message = error.message.replace(/\\/(bot|user)(\\d+):[^/]+\\//, '/$1$2:[REDACTED]/');
    throw error;
}`;

const newCode = `function redactToken(error) {
    try {
        error.message = error.message.replace(/\\/(bot|user)(\\d+):[^/]+\\//, '/$1$2:[REDACTED]/');
    } catch {
        // Some error objects have readonly message property
    }
    throw error;
}`;

if (content.includes('try {')) {
    console.log('Already patched');
} else {
    content = content.replace(oldCode, newCode);
    fs.writeFileSync(file, content);
    console.log('Telegraf patched successfully');
}
