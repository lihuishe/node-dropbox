#!/usr/bin/env babel-node

require('./helper')

const chokidar = require('chokidar')
const net = require('net')
const JsonSocket = require('json-socket')
const path = require('path')
const fs = require('fs').promise
const fss = require('fs')
const Hapi = require('hapi')
const asyncHandlerPlugin = require('hapi-async-handler')
const archiver = require('archiver')
const mime = require('mime-types')
const cat = require('./cat')
const rm = require('./rm')
const mkdir = require('./mkdir')
const rimraf = require('rimraf').promise
const touch = require('./touch')
const ls = require('./ls')
const argv = require('yargs')
    .default('dir', process.cwd())
    .argv
const ROOT_DIR = path.resolve(argv.dir)

// tcp
const sockets = []

// file watches
const modifiedFiles = []

function getLocalFilePathFromRequest(request) {
  return path.join(ROOT_DIR, '/', request.params.file || '')
}

function msg(action, path, dir) {
  let message = {
    action: action,
    path: path,
    type: dir ? 'dir' : 'file',
    updated: Date.now()
  };

  // for each connected client, send message
  for(let socket of sockets) {
    socket.sendMessage(message);
  }
}

// GET
// NO TCP
async function readHandler(request, reply) {
  const filePath = getLocalFilePathFromRequest(request);

  console.log(`Reading ${filePath}`);

  var data = ''
  try{
    const stat = await fs.stat(filePath)
    if(stat.isDirectory()) {
      let files = await fs.readdir(filePath)
      if(request.headers['accept'].includes('application/x-gtar')) {
        let archive = archiver('zip')
        archive.bulk([{ expand: true, cwd: filePath, src: ['**'], dest: '.'}])
               .finalize()
               console.log(JSON.stringify(files));
        return reply(archive)
                .header('Content-Type', 'application/zip')
                .code(200);
      } else {
        console.log(2);
        let payload = JSON.stringify(files);
        return reply(payload)
               .header('Content-Length', payload.length)
               .code(200);
      }
    } else {
      // FILE
      data = await cat(filePath)
      return reply(data)
        .header('Content-Length', data.length)
        .header('Content-Type', mime.lookup(filePath))
        .code(200);
    }
  } catch(err) {
    return reply().code(405)
  }
}

// PUT
// TCP SYNC
async function createHandler(request, reply) {
  /* eslint no-unused-expressions: 0 */
  const filePath = getLocalFilePathFromRequest(request)

  console.log(`Creating ${filePath}`)

  try {
    const stat = await fs.stat(filePath)
    // Already exist, exit
    return reply().code(405);
  } catch(err) {
    // does not exist, then createHandler
    modifiedFiles.push(filePath)

    if(filePath.endsWith('/')) {
      console.log(`Creating directory ${filePath}`);
      await mkdir(filePath)
      msg('write', request.params.file, true);
      return reply(`Created Directory ${filePath}`)
    } else {
      console.log(`Creating file ${filePath}`);
      const wstream = fss.createWriteStream(filePath);
      const rstream = request.payload;
      rstream.pipe(wstream);
      wstream.on('finish', () => {
          msg('write', request.params.file, false);
          reply(`Created file ${request.params.file}.`)
      });
    }
  }
}

// POST
// TCP
async function updateHandler(request, reply) {
  const filePath = getLocalFilePathFromRequest(request)

  if(filePath.endsWith('/')) {
    reply().code(405)
    return;
  }

  console.log(`Updating ${filePath}`)
  try {
    modifiedFiles.push(filePath)
    const wstream = fss.createWriteStream(filePath, {flag: 'w+'});
    const rstream = request.payload;
    rstream.pipe(wstream);

    wstream.on('finish', () => {
      msg('write', request.params.file, false)
      reply(`Updated ${request.params.file}`)
    });
  } catch(err){
    return reply().code(405)
  }
}

// DELETE
// TCP
async function deleteHandler(request, reply) {
  const filePath = getLocalFilePathFromRequest(request)

  let code = 200;
  try {
    modifiedFiles.push(filePath);
    const stat = await fs.stat(filePath)
    console.log(`Deleting ${filePath}`)
    code = await rm(filePath)
    msg('delete', request.params.file, stat.isDirectory());
    return reply(`Deleted ${request.params.file}`).code(code);
  } catch(err) {
    return reply(`Error deleting ${request.params.file}`).code(405);
  }
}

async function init() {
  const port = 8000
  const server = new Hapi.Server({
    debug: {
      request: ['error']
    }
  })
  server.register(asyncHandlerPlugin)
  server.connection({ port })

  server.route([
    // READ
    {
      method: 'GET',
      path: '/{file*}',
      handler: {
        async: readHandler
      }
    },
    // CREATE
    {
      method: 'PUT',
      path: '/{file*}',
      config: {
        payload: {
          output: 'stream',
          parse: false
        }
      },
      handler: {
        async: createHandler
      }
    },
    // UPDATE
    {
      method: 'POST',
      path: '/{file*}',
      config: {
          payload: {
              output: 'stream',
              parse: false
          }
      },
      handler: {
        async: updateHandler
      }
    },
    // DELETE
    {
      method: 'DELETE',
      path: '/{file*}',
      handler: {
        async: deleteHandler
      }
    }
  ])

  await server.start()
  console.log(`LISTENING @ http://127.0.0.1:${port}`)
}

async function initTcp() {
  const port = 8001
  const server = net.createServer()
  server.listen(port, function () {
    console.log(`TCP SERVER @ http://127.0.0.1:${port}`)
  });

  server.on('connection', handleTcp)
}

function handleTcp(socket) {
  var clientAddr = socket.remoteAddress + ':' + socket.remotePort;

  console.log('client: ' + clientAddr + ', connected.')
  // create new socket and add to socket list
  socket = new JsonSocket(socket);
  sockets.push(socket);

  // add handlers
  socket.on('error', onError);
  socket.on('message', onMessage);
  socket.on('close', onClose);

  async function onError(error) {
    console.log('client: ' + clientAddr + ' error: ' + error.message)
  }

  async function onClose() {
    let index = sockets.indexOf(socket);
    if(index != -1) sockets.splice(index, 1);
    console.log('client: ' + clientAddr + ' closed.');
  }

  async function onMessage(message) {
    console.log('client: ' + clientAddr + ' requested: ' + message)

    // notify all
    for(let socket of sockets) {
      socket.sendMessage(message);
    }

    const filePath = path.join(ROOT_DIR, '/', message.path || '')
    modifiedFiles.push(filePath)
    if (message.action === 'delete') {
            console.log('delete on behalf of client %s %s', message.type, filePath)
            if (message.type === 'dir') await rimraf(filePath)
            else await rm(filePath)
        } else {
            console.log('making %s %s on behalf of client', message.type, filePath)
            if (message.type === 'dir') await mkdir(filePath)
            else await touch(filePath)
        }
  }
}

// watch
function removeUnwatchedFile(absolutePath) {
    let i = modifiedFiles.indexOf(absolutePath)
    if (i !== -1) modifiedFiles.splice(i, 1)
    return i === -1
}

function dirOnChange(absolutePath) {
    if (removeUnwatchedFile(absolutePath)) msg('update', path.relative(ROOT_DIR, absolutePath), true)
}

function dirOnDelete(absolutePath) {
    if (removeUnwatchedFile(absolutePath)) msg('delete', path.relative(ROOT_DIR, absolutePath), true)
}

function fileOnCreate(absolutePath) {
    if (removeUnwatchedFile(absolutePath)) msg('update', path.relative(ROOT_DIR, absolutePath), false)
}

function fileOnChange(absolutePath) {
    if (removeUnwatchedFile(absolutePath)) msg('update', path.relative(ROOT_DIR, absolutePath), false)
}

function fileOnDelete(absolutePath) {
    if (removeUnwatchedFile(absolutePath)) msg('delete', path.relative(ROOT_DIR, absolutePath), false)
}

async function initFileWatch() {
  let watch = chokidar.watch(ROOT_DIR, {ignored: /[\/\\]\./})
  watch.on('addDir', dirOnChange)
       .on('unlinkDir', dirOnDelete)
       .on('add', fileOnCreate)
       .on('change', fileOnChange)
       .on('unlink', fileOnDelete);
}

async function main() {
  await init();
  await initTcp();
  await initFileWatch();
}

main()
