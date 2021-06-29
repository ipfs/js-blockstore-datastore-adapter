'use strict'

const drain = require('it-drain')
const pushable = require('it-pushable')
const { Key } = require('interface-datastore')
const { CID } = require('multiformats/cid')
const raw = require('multiformats/codecs/raw')
const Digest = require('multiformats/hashes/digest')
const { base32, base32pad } = require('multiformats/bases/base32')
const { base58btc } = require('multiformats/bases/base58')
const errcode = require('err-code')
const { BlockstoreAdapter } = require('interface-blockstore')

/**
 * Transform a cid to the appropriate datastore key.
 *
 * @param {CID} cid
 * @returns {Key}
 */
function cidToKey (cid) {
  if (!(cid instanceof CID)) {
    throw errcode(new Error('Not a valid cid'), 'ERR_INVALID_CID')
  }

  return new Key('/' + base32.encode(cid.multihash.bytes).slice(1).toUpperCase(), false)
}

/**
 * Transform a datastore Key instance to a CID
 * As Key is a multihash of the CID, it is reconstructed using IPLD's RAW codec.
 * Hence it is highly probable that stored CID will differ from a CID retrieved from blockstore.
 *
 * @param {Key} key
 * @returns {CID}
 */
function keyToCid (key) {
  // Block key is of the form <base32 encoded string>
  return CID.createV1(raw.code, Digest.decode(base32.decode('b' + key.toString().slice(1).toLowerCase())))
}

/**
 * Tries to decode a prefix as the first part of a CID and then
 * strip off the version and codec bytes to just leave part of
 * the multihash.
 *
 * Only really works if the prefix length aligns with the byte
 * boundaries of the encoding.
 *
 * @param {string} prefix
 * @returns {string}
 */
function convertPrefix (prefix) {
  let bytes
  const firstChar = prefix.substring(0, 1)

  if (firstChar === '/') {
    return convertPrefix(prefix.substring(1))
  }

  if (firstChar.toLowerCase() === 'b') {
    // v1 cid prefix, remove version and codec bytes
    bytes = base32.decode(prefix.toLowerCase()).subarray(2)
  } else if (firstChar.toLowerCase() === 'c') {
    // v1 cid prefix, remove version and codec bytes
    bytes = base32pad.decode(prefix.toLowerCase()).subarray(2)
  } else if (firstChar === 'z') {
    // v1 cid
    bytes = base58btc.decode(prefix).subarray(2)
  } else if (firstChar === 'Q') {
    // v0 cid prefix
    bytes = base58btc.decode('z' + prefix)
  } else {
    bytes = base32.decode('b' + prefix.toLowerCase()).subarray(2)
  }

  const str = base32.encode(bytes).substring(1).toUpperCase()

  return str || 'C'
}

/**
 * @param {import('interface-blockstore').Query} query
 * @returns {import('interface-datastore').Query}
 */
function convertQuery (query) {
  return {
    ...query,
    prefix: query.prefix ? `/${convertPrefix(query.prefix)}` : undefined,
    filters: query.filters
      ? query.filters.map(
        filter => (pair) => {
          return filter({ key: keyToCid(pair.key), value: pair.value })
        }
      )
      : undefined,
    orders: query.orders
      ? query.orders.map(
        order => (a, b) => {
          return order({ key: keyToCid(a.key), value: a.value }, { key: keyToCid(b.key), value: b.value })
        }
      )
      : undefined
  }
}

/**
 * @param {import('interface-blockstore').KeyQuery} query
 * @returns {import('interface-datastore').KeyQuery}
 */
function convertKeyQuery (query) {
  return {
    ...query,
    prefix: query.prefix ? `/${convertPrefix(query.prefix)}` : undefined,
    filters: query.filters
      ? query.filters.map(
        filter => (key) => {
          return filter(keyToCid(key))
        }
      )
      : undefined,
    orders: query.orders
      ? query.orders.map(
        order => (a, b) => {
          return order(keyToCid(a), keyToCid(b))
        }
      )
      : undefined
  }
}

/**
 * @typedef {import('interface-blockstore').Query} Query
 * @typedef {import('interface-blockstore').KeyQuery} KeyQuery
 * @typedef {import('interface-blockstore').Pair} Pair
 * @typedef {import('interface-blockstore').Options} Options
 * @typedef {import('interface-datastore').Datastore} Datastore
 * @typedef {import('interface-blockstore').Blockstore} Blockstore
 */

/**
 * @implements {Blockstore}
 */
class BlockstoreDatastoreAdapter extends BlockstoreAdapter {
  /**
   * @param {Datastore} datastore
   */
  constructor (datastore) {
    super()

    this.child = datastore
  }

  open () {
    return this.child.open()
  }

  close () {
    return this.child.close()
  }

  /**
   * @param {Query} query
   * @param {Options} [options]
   */
  async * query (query, options) {
    for await (const { key, value } of this.child.query(convertQuery(query), options)) {
      yield { key: keyToCid(key), value }
    }
  }

  /**
   * @param {KeyQuery} query
   * @param {Options} [options]
   */
  async * queryKeys (query, options) {
    for await (const key of this.child.queryKeys(convertKeyQuery(query), options)) {
      yield keyToCid(key)
    }
  }

  /**
   * @param {CID} cid
   * @param {Options} [options]
   * @returns
   */
  async get (cid, options) {
    return this.child.get(cidToKey(cid), options)
  }

  /**
   * @param {AsyncIterable<CID> | Iterable<CID>} cids
   * @param {Options} [options]
   */
  async * getMany (cids, options) {
    for await (const cid of cids) {
      yield this.get(cid, options)
    }
  }

  /**
   * @param {CID} cid
   * @param {Uint8Array} value
   * @param {Options} [options]
   */
  async put (cid, value, options) {
    await this.child.put(cidToKey(cid), value, options)
  }

  /**
   * @param {AsyncIterable<Pair> | Iterable<Pair>} blocks
   * @param {Options} [options]
   */
  async * putMany (blocks, options) { // eslint-disable-line require-await
    // we cannot simply chain to `store.putMany` because we convert a CID into
    // a key based on the multihash only, so we lose the version & codec and
    // cannot give the user back the CID they used to create the block, so yield
    // to `store.putMany` but return the actual block the user passed in.
    //
    // nb. we want to use `store.putMany` here so bitswap can control batching
    // up block HAVEs to send to the network - if we use multiple `store.put`s
    // it will not be able to guess we are about to `store.put` more blocks
    const output = pushable()

    // process.nextTick runs on the microtask queue, setImmediate runs on the next
    // event loop iteration so is slower. Use process.nextTick if it is available.
    const runner = process && process.nextTick ? process.nextTick : setImmediate

    runner(async () => {
      try {
        const store = this.child

        await drain(this.child.putMany(async function * () {
          for await (const block of blocks) {
            const key = cidToKey(block.key)
            const exists = await store.has(key, options)

            if (!exists) {
              yield { key, value: block.value }
            }

            // there is an assumption here that after the yield has completed
            // the underlying datastore has finished writing the block
            output.push(block)
          }
        }()))

        output.end()
      } catch (err) {
        output.end(err)
      }
    })

    yield * output
  }

  /**
   * @param {CID} cid
   * @param {Options} [options]
   */
  has (cid, options) {
    return this.child.has(cidToKey(cid), options)
  }

  /**
   * @param {CID} cid
   * @param {Options} [options]
   */
  delete (cid, options) {
    return this.child.delete(cidToKey(cid), options)
  }

  /**
   * @param {AsyncIterable<CID> | Iterable<CID>} cids
   * @param {Options} [options]
   */
  deleteMany (cids, options) {
    const out = pushable()

    drain(this.child.deleteMany((async function * () {
      for await (const cid of cids) {
        yield cidToKey(cid)

        out.push(cid)
      }

      out.end()
    }()), options)).catch(err => {
      out.end(err)
    })

    return out
  }
}

module.exports = BlockstoreDatastoreAdapter
