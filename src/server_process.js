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
  var systemAssetDefinitions = [
    {
      monikers: ['gold'],
      colorDescs: ['epobc:b95323a763fa507110a89ab857af8e949810cf1e67e91104cd64222a04ccd0bb:0:180679']
    },
    {
      colorDescs: ['epobc:0261b29b587020eeca15f831a5290a9d81038851da4365689be04e588ce58c66:0:303510'],
      monikers: ['euro'],
      unit: 100
    }
  ];

  wallet = new WalletCore.Wallet({
    testnet: true,
    blockchain: 'NaiveBlockchain',
    systemAssetDefinitions: systemAssetDefinitions
  });

  var mnemonic = 'provide rail journey neither script nasty fetch south seat obvious army two';
  var password = '';
  seed = BIP39.mnemonicToSeedHex(mnemonic, password);
  if (!wallet.isInitialized()) {
    wallet.initialize(seed);
  }
  console.log('My Bitcoin address:');
  console.log(wallet.getSomeAddress(wallet.adManager.getByMoniker('bitcoin'), false));
  wallet.on('error', function (error) { console.log(error); });
  wallet.subscribeAndSyncAllAddresses(function () {});
}

function get_wallet() {
  if (!wallet) {
    initialize_wallet();
  }

  return wallet;
}

function get_seed() {
  if (!seed) {
    initialize_wallet();
  }

  return seed;
}


function check_protocol(msg) {
  if (msg.protocol != 'cwpp/0.0') {
    throw new Error('protocol not supported');
  }
  return true;
}

function cinputs_colordef(payreq, procreq) {
  var colorDesc = payreq.colorDesc;
  return get_wallet().cdManager.resolveByDesc(colorDesc, true);
}

function CInputsOperationalTx(wallet, colordef) {
  this.wallet = wallet;
  this.colordef = colordef;
  this.targets = [];
}

inherits(CInputsOperationalTx, OperationalTx);

CInputsOperationalTx.prototype.getChangeAddress = function (colordef) {
  if (colordef.getColorType() !== 'uncolored') {
    throw new Error('colored change not supported');
  }

  return OperationalTx.prototype.getChangeAddress.call(this, colordef);
};


CInputsOperationalTx.prototype.addColoredInputs = function (cinputs) {
  // dirty hack
  var coinManager = get_wallet().getStateManager()._currentState.getCoinManager();
  this.ccoins = cinputs.map(function (rawCoin) {
    return new Coin(coinManager, rawCoin);
  });
};

CInputsOperationalTx.prototype.getRequiredFee = function (txsize) {
  return new ColorValue(new cclib.UncoloredColorDefinition(), 0);
};

CInputsOperationalTx.prototype.selectCoins = function (colorValue, feeEstimator, cb) {
  var self = this;
  if (colorValue.isUncolored()) {
    return OperationalTx.prototype.selectCoins.call(this, colorValue, feeEstimator, cb);
  }

  var coinList = new CoinList(this.ccoins);
  coinList.getTotalValue(function (error, totalValues) {
    if (error) {
      return cb(error);
    }

    if (totalValues.length !== 1) {
      return cb(new Error('provided coins have ambiguous colorvalue'));
    }

    if (totalValues[0].getColorId() !== self.colordef.getColorId()) {
      return cb(new Error('provided coins are of a wrong color'));
    }

    cb(error, self.ccoins, totalValues[0]);
  });
};

function cinputs_operational_txs(payreq, procreq) {
  var colordef = cinputs_colordef(payreq, procreq);
  function createColorTarget(address, value) {
    return new ColorTarget(addr_to_script_hex(address), new ColorValue(colordef, value));
  }

  var op_txs = new CInputsOperationalTx(get_wallet(), colordef);
  op_txs.addColoredInputs(procreq.cinputs);
  op_txs.addTarget(createColorTarget(payreq.address, payreq.value));
  if (procreq.change) {
    op_txs.addTarget(createColorTarget(procreq.change.address, procreq.change.value));
  }

  return op_txs;
}

function process_cinputs_1(payreq, procreq, cb) {
  var colordef = cinputs_colordef(payreq, procreq);
  var optxs = cinputs_operational_txs(payreq, procreq);
  colordef.constructor.makeComposedTx(optxs, function (error, ctx) {
    if (error) {
      return cb(error);
    }

    get_wallet().transformTx(ctx, 'raw', {}, function (error, tx) {
      if (error) {
        return cb(error);
      }

      cb(null, {'protocol': 'cwpp/0.0', 'tx_data': tx.toHex(true)});
    });
  });
}

function cinputs_check_tx(payreq, procreq, rtx, cb) {
  var tx = rtx.toTransaction(true);
  var colordef = cinputs_colordef(payreq, procreq);
  var getTxFn = get_wallet().getBlockchain().getTxFn();
  get_wallet().getColorData().getTxColorValues(tx, colordef, getTxFn, function (error) {
    // @todo
    cb(error);
  });
}

function process_cinputs_2(payreq, procreq, cb) {
  var tx = RawTx.fromHex(procreq.tx);
  cinputs_check_tx(payreq, procreq, tx, function (error) {
    if (error) {
      return cb(error);
    }

    get_wallet().transformTx(tx, 'signed', {seedHex: seed}, function (error, stx) {
      if (error) {
        return cb(error);
      }

      cb(null, {protocol: 'cwpp/0.0', 'tx_data': stx.toHex()});
    });
  });
}


function process_cinputs(payreq, procreq, cb) {
  if (payreq.messageType != 'PaymentRequest') {
    throw new Error('PaymentRequest expected');
  }

  if (!(payreq.acceptedMethods && payreq.acceptedMethods.cinputs)) {
    throw new Error('PaymentRequest doesn\'t support cinputs');
  }

  if (procreq.stage == 1) {
    return process_cinputs_1(payreq, procreq, cb);
  }

  if (procreq.stage == 2) {
    return process_cinputs_2(payreq, procreq, cb);
  }

  throw new Error('invalid stage for cinputs');
}

function process_request(payreq, procreq, cb) {
  try {
    check_protocol(payreq);
    check_protocol(procreq);

    if (procreq.messageType != 'ProcessRequest') {
      throw new Error('ProcessRequest expected');
    }

    if (procreq.method == 'cinputs') {
      return process_cinputs(payreq, procreq, cb);
    }

    throw new Error('method not supported');
  } catch (error) {
    cb(error, null);
  }
}

module.exports.process_request = process_request;
