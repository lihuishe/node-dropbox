const fs = require('fs').promise

var cat = async function catHandler(filePath){
  return await fs.readFile(filePath)
}

module.exports = cat
