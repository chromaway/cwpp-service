var express = require('express');

var jsonBody = require('body/json');
var sendJson = require('send-data/json');
var stringify = require('json-stable-stringify');
var SHA256 = require('crypto-js/sha256');
var server_process = require('./src/server_process');
var cors = require('cors');
var logger = require('morgan');
var URLSafeBase64 = require('urlsafe-base64');
var fs = require('fs');
var config = require('./config')

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
    fs.writeFileSync('payreqs/' + hash, stringify(body));
    pay_reqs[hash] = body;             
    sendJson(req, res, {"hash": hash});
  });
});

function get_pay_request(rq_hash) {
  var pay_req = pay_reqs[rq_hash];
  if (!pay_req) {
    if (/[^a-zA-Z0-9_\-]/.test(rq_hash)) {
      console.log('bad rq_hash:', rq_hash);
      return null;
    }
    try {
      pay_req = JSON.parse(fs.readFileSync('payreqs/' + rq_hash));
    } catch (x) {
      console.log(x);
    }    
  }
  return pay_req;  
}

cwpp_api.get('/:rq_hash', function (req, res) {
  var pay_req = get_pay_request(req.params.rq_hash);
  if (pay_req) {
    return res.json(pay_req);
  } else {
    return res.status(404).json({error: 'request not found'});
  }
});

function process_request(rq, body, cb) {
  server_process.process_request(rq, body, cb);
}

cwpp_api.post('/process/:rq_hash', function (req, res) {
  var pay_req = get_pay_request(req.params.rq_hash);
  if (!pay_req) {
    return res.status(404).json({error: 'requrest not found'});
  }

  jsonBody(req, function (error, body) {
    if (error) {
      return res.status(400).json({error: 'JSON required'});
    }

    process_request(pay_req, body, function (error, res_body) {
      if (error) {
        res.status(500).json({error: error.toString()});
        console.log(error.stack);
        server_process.log_wallet_state();
      } else {
        res.json(res_body);
      }
    });
  });
});

app.use('/cwpp', cwpp_api);


server_process.initialize_wallet(config, function (error) {
  if (error !== null) {
    throw error;
  }

  var server = app.listen(4243, function () {
    console.log('Listening on port %d', server.address().port);
  });
});
