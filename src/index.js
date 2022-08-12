import drain from 'it-drain'
import { pushable } from 'it-pushable'
import { Key } from 'interface-datastore/key'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import * as Digest from 'multiformats/hashes/digest'
import { base32, base32pad } from 'multiformats/bases/base32'
import { base58btc } from 'multiformats/bases/base58'
import errcode from 'err-code'
import { BaseBlockstore } from 'blockstore-core/base'

/**
 * Transform a cid to the appropriate datastore key.
 *
 * @param {CID} cid
 * @returns {Key}
 */
function cidToKey (cid) {
  const c = CID.asCID(cid)

  if (!c) {
    throw errcode(new Error('Not a valid cid'), 'ERR_INVALID_CID')
  }

  return new Key('/' + base32.encode(c.multihash.bytes).slice(1).toUpperCase(), false)
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
  const firstChar = prefix.substring(0, 1)

  if (firstChar === '/') {
    return convertPrefix(prefix.substring(1))
  }

  /** @type {(input: string) => Uint8Array } */
  let decoder

  if (firstChar.toLowerCase() === 'b') {
    // v1 cid prefix, remove version and codec bytes
    decoder = (input) => base32.decode(input.toLowerCase()).subarray(2)
  } else if (firstChar.toLowerCase() === 'c') {
    // v1 cid prefix, remove version and codec bytes
    decoder = (input) => base32pad.decode(input.toLowerCase()).subarray(2)
  } else if (firstChar === 'z') {
    // v1 cid
    decoder = (input) => base58btc.decode(input).subarray(2)
  } else if (firstChar === 'Q') {
    // v0 cid prefix
    decoder = (input) => base58btc.decode('z' + input)
  } else {
    decoder = (input) => base32.decode('b' + input.toLowerCase()).subarray(2)
  }

  let bytes

  // find the longest prefix that we can safely decode
  for (let i = 1; i < prefix.length; i++) {
    try {
      bytes = decoder(prefix.substring(0, i))
    } catch (/** @type {any} */ err) {
      if (err.message !== 'Unexpected end of data') {
        throw err
      }
    }
  }

  let str = '/C'

  if (bytes) {
    // slice one character from the end of the string to ensure we don't end up
    // with a padded value which could have a non-matching string at the end
    str = `/${base32.encode(bytes).slice(1, -1).toUpperCase() || 'C'}`
  }

  return str
}

/**
 * @param {import('interface-blockstore').Query} query
 * @returns {import('interface-datastore').Query}
 */
function convertQuery (query) {
  return {
    ...query,
    prefix: query.prefix ? convertPrefix(query.prefix) : undefined,
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
    prefix: query.prefix ? convertPrefix(query.prefix) : undefined,
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
export class BlockstoreDatastoreAdapter extends BaseBlockstore {
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
    const output = pushable({
      objectMode: true
    })

    // process.nextTick runs on the microtask queue, setImmediate runs on the next
    // event loop iteration so is slower. Use process.nextTick if it is available.
    const runner = globalThis.process && globalThis.process.nextTick ? globalThis.process.nextTick : (globalThis.setImmediate || globalThis.setTimeout)

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
      } catch (/** @type {any} */ err) {
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
    const out = pushable({
      objectMode: true
    })

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
