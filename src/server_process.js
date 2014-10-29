var WalletCore = require('cc-wallet-core');
var cclib = WalletCore.cclib;
var ColorTarget = cclib.ColorTarget;
var ColorValue = cclib.ColorValue;
var bitcoin = cclib.bitcoin;
var OperationalTx = WalletCore.tx.OperationalTx;
var RawTx = WalletCore.tx.RawTx;
var CoinList = WalletCore.coin.CoinList;
var Coin = WalletCore.coin.Coin;
var inherits = require('util').inherits;
var BIP39 = require('bip39');

var wallet = null;
var seed = null;

function addr_to_script_hex(addr) {
    var script = bitcoin.Address.fromBase58Check(addr).toOutputScript();
    return script.toHex();
}

function initialize_wallet() {
    var systemAssetDefinitions = [{
        monikers: ['gold'],
        colorDescs: ['epobc:b95323a763fa507110a89ab857af8e949810cf1e67e91104cd64222a04ccd0bb:0:180679']
    }];

    wallet = new WalletCore.Wallet(
        {testnet: true, systemAssetDefinitions: systemAssetDefinitions}
    );
    
    var mnemonic = 'provide rail journey neither script nasty fetch south seat obvious army two';
    var password = '';
    seed = BIP39.mnemonicToSeedHex(mnemonic, password);
    if (!wallet.isInitialized()) {
        wallet.initialize(seed);
    }
    console.log("My Bitcoin address:");
    console.log(wallet.getSomeAddress(wallet.adManager.getByMoniker('bitcoin'), false));
    wallet.fullScanAllAddresses(function () {});
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
    var colorDesc = payreq.colorDesc;
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
    var self = this;
    if (!colorValue.isUncolored()) {
        (new CoinList(this.ccoins)).getTotalValue(function (err, totalValues) {
            if (err) cb(err);
            else {
                if (totalValues.length !== 1)
                    cb(new Error('provided coins have ambiguous colorvalue'));
                else if (totalValues[0].getColorId() !== self.colordef.getColorId())
                    cb(new Error('provided coins are of a wrong color'));
                else
                    cb(err, self.ccoins, totalValues[0]);
            }
        });
    } else {
        OperationalTx.prototype.selectCoins.call(
            this, colorValue, feeEstimator, cb);
    }
};


function cinputs_operational_txs(payreq, procreq) {
    var colordef = cinputs_colordef(payreq, procreq);
    var op_txs = new CInputsOperationalTx(get_wallet(), colordef);
    op_txs.addTarget(new ColorTarget(addr_to_script_hex(payreq.address),
                                     new ColorValue(colordef, payreq.value)));
    if (procreq.change)
        op_txs.addTarget(
            new ColorTarget(addr_to_script_hex(procreq.change.address),
                    new ColorValue(colordef, procreq.change.value)));
    op_txs.addColoredInputs(procreq.cinputs);    
    return op_txs;    
}

function process_cinputs_1(payreq, procreq, cb) {
    var colordef = cinputs_colordef(payreq, procreq);
    var optxs = cinputs_operational_txs(payreq, procreq);
    colordef.constructor.makeComposedTx(optxs, function (err, ctx) {
        if (err) return cb(err);
        else return get_wallet().transformTx(ctx, 'raw', null, function (err, tx) {
            if (err) return cb(err);
            return cb(null, {"protocol": "cwpp/0.0",
                             "tx_data": tx.toHex(true)});
        });
    });
}

function cinputs_check_tx(payreq, procreq, rtx, cb) {
    var wallet = get_wallet();
    var bs = wallet.getBlockchain();
    var colordef = cinputs_colordef(payreq, procreq);
    wallet.getColorData().getColorValuesForTx(
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
        get_wallet().transformTx(tx, 'signed', seed, function (err, stx) {
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
