/* eslint-env mocha */

import { MemoryDatastore } from 'datastore-core/memory'
import { BlockstoreDatastoreAdapter } from '../src/index.js'
import { interfaceBlockstoreTests } from 'interface-blockstore-tests'

describe('Memory', () => {
  describe('interface-blockstore', () => {
    interfaceBlockstoreTests({
      setup () {
        return new BlockstoreDatastoreAdapter(
          new MemoryDatastore()
        )
      },
      teardown () {}
    })
  })
})
