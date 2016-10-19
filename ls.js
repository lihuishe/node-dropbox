const fs = require('fs').promise
const path = require('path')

var ls = async function ls(filePath) {
    let stat = await fs.stat(filePath)
    if (!stat.isDirectory()) return [filePath]

    let files = []
    files.push(filePath)

    for (let fileName of await fs.readdir(filePath)) {
        var childPath = path.join(filePath, fileName)
        let result = await ls(childPath)
        files.push(...result)
    }

    return files
}

module.exports = ls
