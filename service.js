var express = require('express');

var jsonBody = require('body/json');
var sendJson = require('send-data/json');
var stringify = require('json-stable-stringify');
var SHA256 = require('crypto-js/sha256');
var server_process = require('./src/server_process');
var cors = require('cors');
var logger = require('morgan');
var URLSafeBase64 = require('urlsafe-base64');


var app = express();

var cors_options = {origin: true, credentials: true};
app.use(logger());
app.use(cors(cors_options));
app.options('*', cors(cors_options));

var cwpp_api = express.Router();

var pay_reqs = {};

function hashMessage_short (body) {
  var sha256hex = SHA256(stringify(body)).toString();
  var slice = (new Buffer(sha256hex, 'hex')).slice(0, 20);
  return URLSafeBase64.encode(slice);
}

cwpp_api.post('/new-request', function (req, res) {
  console.log('new-request');
  jsonBody(req, function (error, body) {
    var hash = SHA256(stringify(body)).toString();
    //var hash = hashMessage_short (body)
    pay_reqs[hash] = body;
    sendJson(req, res, {"hash": hash});
  });
});

cwpp_api.get('/:rq_hash', function (req, res) {
  if (pay_reqs[req.params.rq_hash]) {
    res.json(pay_reqs[req.params.rq_hash]);

  } else {
    res.status(404).json({error: 'requrest not found'});

  }
});

function process_request(rq, body, cb) {
  server_process.process_request(rq, body, cb);
}

cwpp_api.post('/process/:rq_hash', function (req, res) {
  if (typeof pay_reqs[req.params.rq_hash] === 'undefined') {
    return res.status(404).json({error: 'requrest not found'});
  }

  jsonBody(req, function (error, body) {
    if (error) {
      return res.status(400).json({error: 'JSON required'});
    }

    process_request(pay_reqs[req.params.rq_hash], body, function (error, res_body) {
      if (error) {
        res.status(500).json({error: error.toString()});
        console.log(error.stack);

      } else {
        res.json(res_body);

      }
    });
  });
});

app.use('/cwpp', cwpp_api);


server_process.initialize_wallet(function (error) {
  if (error !== null) {
    throw error;
  }

  var server = app.listen(4243, function () {
    console.log('Listening on port %d', server.address().port);
  });
});
