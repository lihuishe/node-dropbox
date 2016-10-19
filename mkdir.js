const fs = require('fs').promise

var mkdir = async function mkdirHandler(dirPath) {
  return await fs.mkdir(dirPath)
}

module.exports = mkdir
