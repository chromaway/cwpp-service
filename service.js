var express = require('express');

var jsonBody = require("body/json");
var sendJson = require("send-data/json");
var stringify = require('json-stable-stringify');
var SHA256 = require("crypto-js/sha256");
var server_process = require("./src/server_process");
var cors = require('cors');
var logger = require('morgan');


var app = express();

var cors_options = {origin: true, credentials: true};
app.use(logger());
app.use(cors(cors_options));
app.options('*', cors(cors_options)); 

var cwpp_api = express.Router();

var pay_reqs = {};

cwpp_api.post('/new-request', function (req, res) {
    console.log('new-request');
    jsonBody(req, function (err, body) {
        var hash = SHA256(stringify(body)).toString();
        pay_reqs[hash] = body;
        sendJson(req, res, {"hash": hash});
    });
});

cwpp_api.get('/:rq_hash', function (req, res) {
    if (pay_reqs[req.params.rq_hash])
        res.json(pay_reqs[req.params.rq_hash]);
    else
        res.status(404).json({error: 'requrest not found'});
});

function process_request(rq, body, cb) {
    server_process.process_request(rq, body, cb);
}

cwpp_api.post('/process/:rq_hash', function (req, res) {
    if (pay_reqs[req.params.rq_hash])
        jsonBody(req, function (err, body) {
            if (err)
                res.status(400).json({error: 'JSON required'});
            else {
                process_request(pay_reqs[req.params.rq_hash], body,
                function (err, res_body) {
                    if (err)
                        res.status(500).json({error: err.toString()});
                    else
                        res.json(res_body);
                });
            }
        });
    else
        res.status(404).json({error: 'requrest not found'});
});

app.use('/cwpp', cwpp_api);


var server = app.listen(4242, function () {
    console.log('Listening on port %d', server.address().port);
});
