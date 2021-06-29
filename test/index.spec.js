/* eslint-env mocha */
'use strict'

const { MemoryDatastore } = require('interface-datastore')
const BlockstoreDatastoreAdapter = require('../src')

describe('Memory', () => {
  describe('interface-blockstore', () => {
    require('interface-blockstore-tests')({
      setup () {
        return new BlockstoreDatastoreAdapter(
          new MemoryDatastore()
        )
      },
      teardown () {}
    })
  })
})
