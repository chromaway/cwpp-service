var Q = require('q');
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

var log_data = require('chroma-log-data');


var wallet = null;
var seed = null;


function addr_to_script_hex(addr) {
  var script = bitcoin.Address.fromBase58Check(addr).toOutputScript();
  return script.toHex();
}

function log_wallet_state() {
  log_data.log('CWPPWalletStateReport', 
    {walletState: get_wallet().walletStateStorage.getState()});
}

function initialize_wallet(done) {
  var systemAssetDefinitions = [{
        "colorDescs": ["epobc:a254bd1a4f30d3319b8421ddeb2c2fd17893f7c6d704115f2cb0f5f37ad839af:0:354317"],
        "monikers": ["euro"], 
        "unit": 100
  }];

  wallet = new WalletCore.Wallet({
    testnet: false,
    storageSaveTimeout: 0,
    spendUnconfirmedCoins: true,
    systemAssetDefinitions: systemAssetDefinitions
  });
  wallet.on('error', function (error) {
    console.log('Wallet error: ', error.stack || error);
  });

  var mnemonic = 'provide rail journey neither script nasty fetch south seat obvious army two';
  var password = '';
  seed = BIP39.mnemonicToSeedHex(mnemonic, password);
  if (!wallet.isInitialized()) {
    wallet.initialize(seed);
  }

  var bitcoinAsset = wallet.getAssetDefinitionByMoniker('bitcoin');
  console.log('My Bitcoin address:', wallet.getSomeAddress(bitcoinAsset));


  wallet.once('syncStop', function () {
    return Q.ninvoke(wallet, 'getBalance', bitcoinAsset)
    .then(function (balance) {
    console.log('My balance:', balance);

    var coinQuery = wallet.getCoinQuery().includeUnconfirmed();
    return Q.ninvoke(coinQuery, 'getCoins').then(function (coinList) {
      if (coinList.getCoins().length > 10) {
        return coinList.getCoins().length;
      }

      var opts = {
        seed: seed,
        assetdef: bitcoinAsset,
        count: 15,
        totalAmount: balance.total - 20000
      };
      return Q.nfcall(WalletCore.util.createCoins, wallet, opts).then(function () {
        return opts.count + 1;

      });

    }).then(function (count) {
      console.log('I have ' + count + ' coins');
      return null;

    });

  }).done(done, done)});
}

function get_wallet() {
  if (wallet === null) {
    throw new Error('Initialize wallet first!');
  }

  return wallet;
}

function get_seed() {
  if (seed === null) {
    throw new Error('Initialize wallet first!');
  }

  return seed;
}

var foreignCoinMethods = {
  isCoinAvailable: function () {
    return true;
  },
  getCoinMainColorValue: function () {
    var wsm = get_wallet().getStateManager();
    return wsm.getCoinMainColorValue.apply(wsm, Array.prototype.slice.call(arguments));
  }
};


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
  this.ccoins = cinputs.map(function (rawCoin) {
    return new Coin(rawCoin, foreignCoinMethods);
  });
};

CInputsOperationalTx.prototype.selectCoins = function (colorValue, feeEstimator, cb) {
  var self = this;
  if (colorValue.isUncolored()) {
    var fn = OperationalTx.prototype.selectCoins.bind(this);
    return Q.nfcall(fn, colorValue, feeEstimator).spread(function (coins, totalValue) {
      var promises = coins.map(function (coin) {
        var lockTime = Math.round(Date.now() / 1000) + 60 * 60;
        return Q.ninvoke(coin, 'freeze', {timestamp: lockTime});
      });

      return Q.all(promises).then(function () {
        return [coins, totalValue];
      });
    }).done(
      function (result) { cb(null, result[0], result[1]); },
      function (error) { cb(error); }
    );
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
  cb(null)
//  get_wallet().getStateManager().getTxColorValues(tx, colordef).done(
//   function () { cb(null) },
//   function (err) { cb(err) })
    // @todo
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


module.exports = {
  initialize_wallet: initialize_wallet,
  process_request: process_request,
  log_wallet_state: log_wallet_state
};
