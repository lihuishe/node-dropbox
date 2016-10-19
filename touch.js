const fs = require('fs').promise

var touch = async function touchHandler(filePath) {
  await fs.open(filePath, 'wx')
}

module.exports = touch
