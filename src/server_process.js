var WalletCore = require('cc-wallet-core');
var OperationalTx = WalletCore.tx.OperationalTx;
var CoinList = WalletCore.coin.CoinList;
var inherits = require('util').inherits;
var BIP39 = require('BIP39');

var wallet = null;
var seed = null;


function initialize_wallet() {
    var systemAssetDefinitions = [{
        monikers: ['gold'],
        colorSchemes: ['epobc:b95323a763fa507110a89ab857af8e949810cf1e67e91104cd64222a04ccd0bb:0:180679']
    }];

    wallet = new ccWallet(
        {testnet: true, systemAssetDefinitions: systemAssetDefinitions}
    );
    
    var mnemonic = '';
    var password = '';
    seed = BIP39.mnemonicToSeedHex(mnemonic, password);
    if (!wallet.isInitialized()) {
        wallet.initialzie(seed);
    }
}

function get_wallet() {
    if (!wallet) initialize_wallet();
    return wallet;
}

function get_seed() {
    if (!seed) initialize_wallet();
    return seed;
}



function check_protocol(msg) {
    if (msg.protocol != 'cwpp/0.0')
        throw "protocol not supported";
    return true;
}

function cinputs_colordef(payreq, procreq) {
    var colorDesc = procreq.colorDesc;
    return get_wallet().cdManager.resolveByDesc(colorDesc, false);
}

function CInputsOperationalTx(wallet, colordef) {
    this.wallet = wallet;
    this.colordef = colordef;
    this.targets = [];
}

inherits(CInputsOperationalTx, OperationalTx);

CInputsOperationalTx.prototype.getChangeAddress = function (colordef) {
    if (colordef.getColorType() !== 'uncolored')
        throw new Error('colored change not supported');
    return OperationalTx.prototype.getChangeAddress.call(this, colordef);
}


CInputsOperationalTx.prototype.addColoredInputs = function (cinputs) {
    var wallet = get_wallet();
    this.ccoins = cinputs.map(function (rawCoin) {
        return new Coin(wallet.coinManager, rawCoin);
    });
};


CInputsOperationalTx.prototype.selectCoins = function (colorValue, 
    feeEstimator, cb) {
    if (!colorValue.isUncolored()) {
        (new CoinList(this.ccoins)).getTotalValue(function (err, totalValues) {
            if (err) cb(err);
            else {
                var totalValue = totalValues[this.colordef.getColorId()];
                cb(err, this.ccoins, totalValue);
            }
        });
    } else {
        OperationalTx.prototype.selectCoins.call(
            this, colorValue, feeEstimator, cb);
    }
};


function cinputs_operational_txs(payreq, procreq) {
    var colordef = cinputs_colordef(payreq, procreq);
    var op_txs = new CInputsOperationalTx(get_wallet());
    op_txs.addTarget(new ColorTarget(payreq.address,
                                     new ColorValue(colordef, payreq.value)));
    if (procreq.change)
        op_txs.addTarget(
            new ColorTarget(procreq.change.address,
                    new ColorValue(colordef, procreq.change.value)));
    op_txs.addColorInputs(procreq.cinputs);    
    return op_txs;    
}

function process_cinputs_1(payreq, procreq, cb) {
    var colordef = cinputs_colordef(payreq, procreq);
    var optxs = cinputs_operational_txs(payreq, procreq);
    colordef.makeComposedTx(optxs, function (err, ctx) {
        if (err) return cb(err);
        else return transformTx(ctx, 'raw', null, function (err, tx) {
            if (err) return cb(err);
            return cb(null, {"protocol": "cwpp/0.0",
                             "tx_data": tx.toHex()});
        });
    });
}

function cinputs_check_tx(payreq, procreq, rtx, cb) {
    var wallet = get_wallet();
    var bs = wallet.getBlockchain();
    var colordef = cinputs_colordef(payreq, procreq);
    wallet.getColorData().getColorValuesRaw(
        rtx.toTransaction(true), colordef, bs.getTx.bind(bs), 
        function (err, colorvalues) {
            // TODO
            if (err) cb(err);
            else cb(null);
        });
}

function process_cinputs_2(payreq, procreq, cb) {
    var tx = RawTx.fromHex(procreq.tx);
    cinputs_check_tx(payreq, procreq, tx, function (err) {
        if (err) cb(err);
        else 
        transformTx(tx, 'signed', seed, function (err, stx) {
            if (err) cb(err);
            else cb(null, {protocol: "cwpp/0.0",
                           "tx_data": stx.toHex()});
        });
    });
}


function process_cinputs(payreq, procreq, cb) {
    if (payreq.messageType != 'PaymentRequest')
        throw "PaymentRequest expected";
    if (!(payreq.acceptedMethods && 
          payreq.acceptedMethods['cinputs']))
        throw "PaymentRequest doesn't support cinputs";
    if (procreq.stage == 1)
        return process_cinputs_1(payreq, procreq, cb);
    else if (procreq.stage == 2)
        return process_cinputs_2(payreq, procreq, cb);
    else
        throw 'invalid stage for cinputs';
}

function process_request(payreq, procreq, cb) {
    try {
        check_protocol(payreq);
        check_protocol(procreq);
        if (procreq.messageType != 'ProcessRequest')
            throw "ProcessRequest expected";
        if (procreq.method == 'cinputs')
            return process_cinputs(payreq, procreq, cb);
        else
            throw "method not supported";
    } catch (x) {
        cb(x, null);
    }
    
}

module.exports.process_request = process_request;