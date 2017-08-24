const mongoose = require('mongoose'),
  config = require('../../config'),
  blockModel = require('../../models').blockModel,
  _ = require('lodash'),
  bunyan = require('bunyan'),
  Web3 = require('web3'),
  net = require('net'),
  amqp = require('amqplib'),
  log = bunyan.createLogger({name: 'app'}),
  blockProcessService = require('./services/blockProcessService'),
  eventsEmitterService = require('./services/eventsEmitterService');

/**
 * @module entry point
 * @description registers all smartContract's events,
 * listen for changes, and notify plugins.
 */


mongoose.connect(config.mongo.uri);

//we expose network name to webworker from muster node

//init contracts on the following network and fetch the latest block for this network from mongo

const init = async () => {

  let currentBlock = await blockModel.findOne({network: config.web3.network}).sort('-block');
  currentBlock = _.chain(currentBlock).get('block', 0).add(0).value();
  log.info(`search from block:${currentBlock} for network:${config.web3.network}`);

  let provider = new Web3.providers.IpcProvider(config.web3.uri, net);
  const web3 = new Web3();
  web3.setProvider(provider);

  let amqpInstance = await amqp.connect(config.rabbit.url);

  let processBlock = async () => {
    try {
      let filtered = await blockProcessService(currentBlock, web3);

      await Promise.all(
        filtered.events.map(ev => ev.payload.save().catch(() => {
        }))
      );

      await Promise.all(
        filtered.balance.map(tx => tx.save().catch(() => {
        }))
      );

      await Promise.all(
        _.chain(filtered.balance)
          .map(tx =>
            [tx.from, tx.to].map(address =>
              eventsEmitterService(amqpInstance, `eth_transaction.${address}`, tx.payload)
                .catch(() => {
                })
            )
          )
          .flattenDeep()
          .value()
      );

      await Promise.all(
        filtered.events.map(event =>
          eventsEmitterService(amqpInstance, `eth_${event.name.toLowerCase()}`, event.payload.controlIndexHash)
        )
      );

      await blockModel.findOneAndUpdate({network: config.web3.network}, {
        $set: {
          block: currentBlock,
          created: Date.now()
        }
      }, {upsert: true});

      currentBlock++;
      processBlock();
    } catch (err) {

      if (_.has(err, 'cause') && err.cause.toString().includes('CONNECTION ERROR'))
        return process.exit(-1);

      if (_.get(err, 'code') === 0) {
        log.info(`await for next block ${currentBlock}`);
        return setTimeout(processBlock, 10000);
      }

      currentBlock++;
      processBlock();
    }
  };

  processBlock();

};

module.exports = init();