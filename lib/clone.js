var concat = require('concat-stream')
  , request = require('hyperquest')
  , through = require('through')
  , crypto = require('crypto')
  , url = require('url')

var buildHeaders = require('./build-headers.js')
  , toPackage = require('./to-package.js')

module.exports = clone

function clone(pkg, src, dst, credentials, xform, ready) {
  var sourceRegistry = src
    , targetRegistry = dst

  pkg = typeof pkg === 'string'
    ? toPackage(pkg)
    : pkg

  if(arguments.length === 5) {
    ready = xform
    xform = null
  } else if(arguments.length === 4) {
    ready = credentials
    xform = credentials = null
  }

  var metadataUrl = url.resolve(
      sourceRegistry
    , pkg.name + '/' + (pkg.version || '*')
  )

  var shasum = crypto.createHash('sha1')
    , metadata
    , tarball
    , publish
    , dist
    , sha
    , req

  req = request(metadataUrl)

  req
      .on('error', onerror)
    .pipe(xform || through())
      .on('error', onerror)
    .pipe(concat(onmetadata))
      .on('error', onerror)

  function onmetadata(data) {
    var responseOkay = req.response.statusCode > 199 &&
      req.response.statusCode < 300

    if(!responseOkay) {
      return onerror(
          new Error('metadata error: ' + req.response.statusCode)
      )
    }

    metadata = JSON.parse(data)
    dist = metadata.dist

    tarball = request(dist.tarball)

    tarball.on('error', onerror)

    tarball.pipe(shasum).on('data', function(buf) {
      sha = buf.toString('hex')
    })
    tarball.pipe(concat(ontarball))
      .on('error', onerror)
  }

  function ontarball(tarballData) {
    var responseOkay = tarball.response.statusCode > 199 &&
      tarball.response.statusCode < 300

    if(!responseOkay) {
      return onerror(
          new Error('tarball error: ' + tarball.response.statusCode)
      )
    }

    if(sha !== dist.shasum) {
      return ready(new Error('shasum mismatch'))
    }

    var version = metadata.version

    metadata.versions = {}
    metadata.versions[metadata.version] = JSON.parse(JSON.stringify(metadata))
    delete metadata.version

    metadata['dist-tags'] = {'latest': version}
    metadata._attachments = {}
    metadata._attachments[metadata.name + '-' + version + '.tgz'] = {
        'content_type': 'application/octet-stream'
      , 'data': tarballData.toString('base64')
      , 'length': tarballData.length
    }

    var content = JSON.stringify(metadata)

    publish = request.put(url.resolve(
        targetRegistry
      , pkg.name
    ), {headers: buildHeaders(credentials, content)})

    publish
      .on('error', onerror)
      .pipe(concat(onfinish))
      .on('error', onerror)

    publish.end(content)
  }

  function onfinish(data) {
    var responseOkay = publish.response.statusCode > 199 &&
      publish.response.statusCode < 300

    if(!responseOkay) {
      // conflict means "it's already up there, dude."
      if(publish.response.statusCode === 409) {
        return ready(null)
      }

      return onerror(
          new Error('publish error: ' + publish.response.statusCode)
      )
    }

    return ready(null)
  }

  function onerror(err) {
    var cb = ready

    ready = Function()
    cb(err)
  }
}

