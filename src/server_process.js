var Q = require('q');
var WalletCore = require('cc-wallet-core');
var cclib = WalletCore.cclib;
var ColorTarget = cclib.ColorTarget;
var ColorValue = cclib.ColorValue;
var bitcoin = cclib.bitcoin;
var Script = bitcoin.Script
var OperationalTx = WalletCore.tx.OperationalTx;
var RawTx = WalletCore.tx.RawTx;
var CoinList = WalletCore.coin.CoinList;
var Coin = WalletCore.coin.Coin;
var inherits = require('util').inherits;
var BIP39 = require('bip39');
var _ = require('lodash');

var log_data = require('chroma-log-data');


var wallet = null;
var seed = null;

var exchangeMap = {}
var collectionAddresses = {}
var allowUnconfirmedCoins = false
var obsoleteColors = []

function addr_to_script_hex(addr) {
  var script = bitcoin.Address.fromBase58Check(addr).toOutputScript();
  return script.toHex();
}

function log_wallet_state() {
  log_data.log('CWPPWalletStateReport',
    {walletState: get_wallet().walletStateStorage.getState()});
}

function initialize_wallet(config, done) {
  wallet = new WalletCore.Wallet({
    testnet: config.testnet,
    storageSaveTimeout: 0,
    spendUnconfirmedCoins: config.spendUnconfirmedCoins,
    systemAssetDefinitions: config.assetDefinitions
  });
  wallet.on('error', function (error) {
    console.log('Wallet error: ', error.stack || error);
  });

  if (config.exchangeMap) exchangeMap = config.exchangeMap  
  if (config.collectionAddresses) collectionAddresses = config.collectionAddresses
  if (config.allowUnconfirmedCoins) allowUnconfirmedCoins = true
  if (config.obsoleteColors) obsoleteColors = config.obsoleteColors

  seed = BIP39.mnemonicToSeedHex(config.walletMnemonic, config.walletPassword);
  if (!wallet.isInitialized()) {
    wallet.initialize(seed);
  }

  var bitcoinAsset = wallet.getAssetDefinitionByMoniker('bitcoin');
  console.log('My Bitcoin address:', wallet.getSomeAddress(bitcoinAsset));
  var euroAsset = wallet.getAssetDefinitionByMoniker('euro2');
  console.log('My Euro address:', wallet.getSomeAddress(euroAsset, true));

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

function cinputs_colordef(req) {
  var colorDesc = req.colorDesc;
  return get_wallet().cdManager.resolveByDesc(colorDesc, true);
}

function CInputsOperationalTx(wallet, in_colordef, out_colordef) {
  this.wallet = wallet;
  this.in_colordef = in_colordef;
  this.out_colordef = out_colordef;
  this.targets = [];
  this.suppliedValue = null
}

inherits(CInputsOperationalTx, OperationalTx);

CInputsOperationalTx.prototype.addSupply = function (suppliedValue) {
  if (this.suppliedValue) throw new Error('can supply only a single color')
  this.suppliedValue = suppliedValue
}

CInputsOperationalTx.prototype.getChangeAddress = function (colordef) {
  if ((colordef.getColorType() === 'uncolored')
      || (this.suppliedValue && this.suppliedValue.getColorId() === colordef.getColorId()))
    return OperationalTx.prototype.getChangeAddress.call(this, colordef);
  else
    throw new Error('no change address for this color ' + colordef.getDesc());
};

CInputsOperationalTx.prototype.addColoredInputs = function (cinputs) {
  this.ccoins = cinputs.map(function (rawCoin) {
    return new Coin(rawCoin, foreignCoinMethods);
  });
};

CInputsOperationalTx.prototype.selectCoins = function (colorValue, feeEstimator, cb) {
  var self = this;

  var useOwnCoins = false

  if (colorValue.isUncolored())
    useOwnCoins = true
  else {
    if (this.suppliedValue && this.suppliedValue.getColorId() === colorValue.getColorId()) {
      if (colorValue.getValue() <= this.suppliedValue.getValue()) {
        useOwnCoins = true
      } else {
        return cb(new Error("requested value exceeds allowed supply: " 
                            + colorValue.getValue().toString() + " > " 
                            + this.suppliedValue.getValue().toString()))
      }
    }
  }

  if (useOwnCoins) {
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

    if (totalValues[0].getColorId() !== self.in_colordef.getColorId()) {
      return cb(new Error('provided coins are of a wrong color'));
    }

    cb(error, self.ccoins, totalValues[0]);
  });
};


function allowedExchange(in_cd, out_cd) {
  if (exchangeMap[in_cd.getDesc()] === out_cd.getDesc())
    return true
  else
    return false
}

function cinputs_operational_txs(payreq, procreq) {
  var out_colordef = cinputs_colordef(payreq);
  var in_colordef = cinputs_colordef(procreq);

  function createColorTarget(address, colordef, value) {
    return new ColorTarget(addr_to_script_hex(address), new ColorValue(colordef, value));
  }

  var op_txs = new CInputsOperationalTx(get_wallet(), in_colordef, out_colordef);
  op_txs.addColoredInputs(procreq.cinputs);

  if (in_colordef.getColorId() !== out_colordef.getColorId()) {
    if (!allowedExchange(in_colordef, out_colordef)) 
      throw new Error('exchange not allowed')
    op_txs.addSupply(new ColorValue(out_colordef, payreq.value))
    var address = (collectionAddresses[in_colordef.getDesc()] 
                   || get_wallet().getSomeAddress(in_colordef))
    op_txs.addTarget(createColorTarget(address,
                                       in_colordef, payreq.value))
  }

  op_txs.addTarget(createColorTarget(payreq.address, out_colordef, payreq.value));
  if (procreq.change) {
    op_txs.addTarget(createColorTarget(procreq.change.address, in_colordef, procreq.change.value));
  }

  return op_txs;
}

function process_cinputs_1(payreq, procreq, cb) {
  var colordef = cinputs_colordef(payreq);
  if (_.contains(obsoleteColors, colordef.getDesc())) {
    return cb(new Error("Please update your wallet app"))
  }
  var optxs = cinputs_operational_txs(payreq, procreq);
  colordef.constructor.makeComposedTx(optxs, function (error, ctx) {
    if (error) {
      return cb(error);
    }
    get_wallet().transformTx(ctx, 'raw', {}, function (error, tx) {
      if (error) {
        return cb(error);
      }
      var tx_hash = tx.toTransaction(true).getId()
      if (payreq.__txids === undefined) payreq.__txids = []
      payreq.__txids.push(tx_hash)
      cb(null, {'protocol': 'cwpp/0.0', 'tx_data': tx.toHex(true)});
    });
  });
}

function cinputs_check_tx(payreq, procreq, rtx, cb) {
  var tx = rtx.toTransaction(true);
  tx.ins.map(function (txin) {  txin.script = Script.EMPTY })
  var txid  = tx.getId()
  if (payreq.__txids && _.contains(payreq.__txids, txid))
    cb(null)
  else
    cb(new Error('Transaction check failed'))
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
      console.log(stx.getId());
      console.log(stx.toHex());
      cb(null, {protocol: 'cwpp/0.0', 'tx_data': stx.toHex()});
    });
  });
}

function isAllTxIdsConfirmed (txIds) {
  if (allowUnconfirmedCoins)
    return Q(true)
  return Q.all(txIds.map(function (txId) {
    return wallet.getBlockchain().getTxBlockHash(txId)
      .then(function (txb) { 
         console.log(txb.source);
         return txb.source === 'blocks'; 
       });
  }))
  .then((function (vals) {
    if (_.all(vals) === false) {
      throw new Error('coins are not confirmed yet');
    }
  }));
}

function process_cinputs(payreq, procreq, cb) {
  if (payreq.messageType != 'PaymentRequest') {
    throw new Error('PaymentRequest expected');
  }

  if (!(payreq.acceptedMethods && payreq.acceptedMethods.cinputs)) {
    throw new Error('PaymentRequest doesn\'t support cinputs');
  }

  var txIds;
  var nextFn;

  if (procreq.stage == 1) {
    txIds = _.pluck(payreq.cinputs, 'txId');
    nextFn = process_cinputs_1;
  } else if (procreq.stage == 2) {
    var tx = RawTx.fromHex(procreq.tx).toTransaction(true)
    txIds = tx.ins.map(function (input) {
      return bitcoin.util.hashEncode(input.hash)
    });
    nextFn = process_cinputs_2;
  } else {
    throw new Error('invalid stage for cinputs');
  }

  isAllTxIdsConfirmed(_.uniq(txIds))
    .then(function () {
      nextFn(payreq, procreq, cb);
    })
    .catch(function (err) {
      cb(err);
    });
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
