require('./helper')

const argv = require('yargs')
    .default('dir', process.cwd())
    .argv
const net = require('net')
const JsonSocket = require('json-socket')
const request = require('request')
const unzip = require('unzip2')
const fs = require('fs')
const path = require('path')
const rimraf = require('rimraf').promise
const cat = require('./cat')
const rm = require('./rm')
const ls = require('./ls')
const mkdir = require('./mkdir')
const touch = require('./touch')
const chokidar = require('chokidar')

// socket
var socket;

// watch file tracker
const modifiedFiles = {}

// const
const port = 8001;
const host = '127.0.0.1';
const server = `http://${host}:8000/`;
const ROOT_DIR = path.resolve(argv.dir);

function getLocalPath(filePath) {
    return path.join(ROOT_DIR, filePath)
}

function getRemotePath(absolutePath){
  return server + path.relative(ROOT_DIR, absolutePath)
}

function isMessageOutdated(message) {
    let absolutePath = getLocalPath(message.path || '')
    if (absolutePath in modifiedFiles) return modifiedFiles[absolutePath] >= message.updated
    else return false
}

// TCP
async function msg(action, path, isDir) {
    let absolutePath = getLocalPath(path || '');
    const message = { action: action, path: path, type: isDir ? 'dir' : 'file', updated: Date.now() };
    modifiedFiles[absolutePath] = message.updated;
    socket.sendMessage(message);
    console.log('sending message: %j', message);
}

async function init() {
    const watcher = chokidar.watch(ROOT_DIR, { ignored: /[\/\\]\./ });
    socket = new JsonSocket(new net.Socket());

    socket.connect(port, host);
    socket.on('connect', onConnect);
    socket.on('message', onMessage);

    async function onConnect() {
      console.log('connection established, syncing...')
      let options = { url: server, headers: {'Accept': 'application/x-gtar'}};
      let rstream = request(options, server);
      rstream.pipe(unzip.Extract( { path: ROOT_DIR} ), { end: false });
      rstream.on('end', async() => {
        const currentFiles = await ls(ROOT_DIR)
        for (let file of currentFiles) modifiedFiles[file] = (await fs.promise.stat(file)).mtime.getTime()

        watcher
            .on('addDir', dirOnChange)
            .on('unlinkDir', dirOnDelete)
            .on('add', fileOnCreate)
            .on('change', fileOnChange)
            .on('unlink', fileOnDelete)
      });
    }

    async function onMessage(message) {
      console.log('message from server: %j', message)
      if (isMessageOutdated(message)) return;

      let filePath = getLocalPath(message.path)
      if (message.action === 'delete') {
          if (message.type === 'file') await rm(filePath)
          else await rimraf(filePath)
          console.log('Deleted ' + filePath)

          watcher.unwatch(filePath)
      } else {
          if (message.type == 'dir') await mkdir(filePath)
          else request({url: server + message.path}, server).pipe(fs.createWriteStream(filePath, 'utf-8'))
          console.log('Created/updated ' + filePath)

          let stat = await fs.promise.stat(filePath)
          modifiedFiles[filePath] = stat.mtime.getTime()
      }
    }
}

async function dirOnDelete(absolutePath) {
    msg('delete', path.relative(ROOT_DIR, absolutePath), true)
}

async function shouldWatchFile(absolutePath) {
    let stat = await fs.promise.stat(absolutePath)
    if (absolutePath in modifiedFiles) return modifiedFiles[absolutePath] < stat.mtime.getTime()
    else return true
}

async function fileOnCreate(absolutePath) {
    const fileChanged = await shouldWatchFile(absolutePath)
    if (fileChanged) {
      let remotePath = getRemotePath(absolutePath)
      console.log(`fileOnCreate: ${absolutePath} to ${remotePath}`)
      msg('update', path.relative(ROOT_DIR, absolutePath), false)
    }
}

async function fileOnChange(absolutePath) {
    const fileChanged = await shouldWatchFile(absolutePath)
    if (fileChanged) {
        let remotePath = getRemotePath(absolutePath)
        console.log(`fileOnChange: ${absolutePath} to ${remotePath}`)
        let rstream = fs.createReadStream(absolutePath)
        rstream.pipe(request.post(remotePath), {end: false})
        rstream.on('end', () => { modifiedFiles[absolutePath] = Date.now()});
    }
}

async function fileOnDelete(absolutePath) {
    let remotePath = getRemotePath(absolutePath)
    console.log(`fileOnDelete: ${absolutePath} to ${remotePath}`)
    msg('delete', path.relative(ROOT_DIR, absolutePath), false)
}

async function dirOnChange(absolutePath) {
    const fileChanged = await shouldWatchFile(absolutePath)
    if (fileChanged) {
      let remotePath = getRemotePath(absolutePath)
      console.log(`dirOnChange: ${absolutePath} to ${remotePath}`)
      msg('update', path.relative(ROOT_DIR, absolutePath), true);
    }
}

async function main() {
    await init();
}

main()
