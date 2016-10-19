const fs = require('fs').promise
const rimraf = require('rimraf')

var rm = async function rmHandler(filePath){
  try {
    const stat = await fs.stat(filePath)

    if(stat.isDirectory()) {
      rimraf(filePath, fs, function(){})
    } else {
      await fs.unlink(filePath)
    }

    return 200;
  } catch(err) {
    return 404;
  }
}

module.exports = rm
