/*!
 * Copyright (c) 2017-2018 Digital Bazaar, Inc. All rights reserved.
 */
'use strict';

const constants = require('../constants');
const jsonld = require('jsonld');
const util = require('../util');
const LinkedDataProof = require('./LinkedDataProof');

module.exports = class LinkedDataSignature extends LinkedDataProof {
  /**
   * @param type {string} Provided by subclass.
   *
   * One of these parameters is required to use a suite for signing:
   *
   * @param [creator] {string} A key id URL to the paired public key.
   * @param [verificationMethod] {string} A key id URL to the paired public key.
   *
   * Advanced optional parameters and overrides:
   *
   * @param [proof] {object} a JSON-LD document with options to use for
   *   the `proof` node (e.g. any other custom fields can be provided here
   *   using a context different from security-v2).
   * @param [date] {string|Date} signing date to use if not passed.
   * @param [useNativeCanonize] {boolean} true to use a native canonize
   *   algorithm.
   */
  constructor({
    type, creator, verificationMethod, proof, date,
    useNativeCanonize} = {}) {
    // validate common options
    if(verificationMethod !== undefined &&
      typeof verificationMethod !== 'string') {
      throw new TypeError('"verificationMethod" must be a URL string.');
    }
    super({type});
    this.creator = creator;
    this.verificationMethod = verificationMethod;
    this.proof = proof;
    if(date !== undefined) {
      this.date = new Date(date);
      if(isNaN(this.date)) {
        throw TypeError(`"date" "${date}" is not a valid date.`);
      }
    }
    this.useNativeCanonize = useNativeCanonize;
  }

  /**
   * @param document {object} to be signed.
   * @param purpose {ProofPurpose}
   * @param documentLoader {function}
   * @param expansionMap {function}
   * @param compactProof {boolean}
   *
   * @returns {Promise<object>} Resolves with the created proof object.
   */
  async createProof(
    {document, purpose, documentLoader, expansionMap, compactProof}) {
    // build proof (currently known as `signature options` in spec)
    let proof;
    if(this.proof) {
      // use proof JSON-LD document passed to API
      proof = await jsonld.compact(
        this.proof, constants.SECURITY_CONTEXT_URL,
        {documentLoader, expansionMap, compactToRelative: false});
    } else {
      // create proof JSON-LD document
      proof = {'@context': constants.SECURITY_CONTEXT_URL};
    }

    // ensure proof type is set
    proof.type = this.type;

    // set default `now` date if not given in `proof` or `options`
    let date = this.date;
    if(proof.created === undefined && date === undefined) {
      date = new Date();
    }

    // ensure date is in string format
    if(date !== undefined && typeof date !== 'string') {
      date = util.w3cDate(date);
    }

    // add API overrides
    if(date !== undefined) {
      proof.created = date;
    }
    // `verificationMethod` is for newer suites, `creator` for legacy
    if(this.verificationMethod !== undefined) {
      proof.verificationMethod = this.verificationMethod;
    }
    if(this.creator !== undefined) {
      proof.creator = this.creator;
    }

    // add any extensions to proof (mostly for legacy support)
    proof = await this.updateProof({
      document, proof, purpose,
      documentLoader, expansionMap, compactProof});

    // allow purpose to update the proof; the `proof` is in the
    // SECURITY_CONTEXT_URL `@context` -- therefore the `purpose` must
    // ensure any added fields are also represented in that same `@context`
    proof = await purpose.update(
      proof, {document, suite: this, documentLoader, expansionMap});

    // create data to sign
    const verifyData = await this.createVerifyData(
      {document, proof, documentLoader, expansionMap, compactProof});

    // sign data
    proof = await this.sign(
      {verifyData, document, proof, documentLoader, expansionMap});

    return proof;
  }

  /**
   * @param document {object} to be signed.
   * @param purpose {ProofPurpose}
   * @param documentLoader {function}
   * @param expansionMap {function}
   * @param compactProof {boolean}
   *
   * @returns {Promise<object>} Resolves with the created proof object.
   */
  async updateProof({proof}) {
    // extending classes may do more
    return proof;
  }

  /**
   * @param proof {object} the proof to be verified.
   * @param document {object} the document the proof applies to.
   * @param purpose {ProofPurpose}
   * @param documentLoader {function}
   * @param expansionMap {function}
   * @param compactProof {boolean}
   *
   * @returns {Promise<{object}>} Resolves with the verification result.
   */
  async verifyProof({
    proof, document, purpose, documentLoader, expansionMap,
    compactProof}) {
    try {
      // create data to verify
      const verifyData = await this.createVerifyData(
        {document, proof, documentLoader, expansionMap, compactProof});

      // fetch verification method
      const verificationMethod = await this.getVerificationMethod(
        {proof, document, documentLoader, expansionMap});

      // verify signature on data
      const verified = await this.verifySignature({
        verifyData, verificationMethod, document, proof,
        documentLoader, expansionMap});
      if(!verified) {
        throw new Error('Invalid signature.');
      }

      // ensure proof was performed for a valid purpose
      const purposeResult = await purpose.validate(
        proof, {document, suite: this, verificationMethod,
          documentLoader, expansionMap});
      if(!purposeResult.valid) {
        throw purposeResult.error;
      }

      return {verified: true, purposeResult};
    } catch(error) {
      return {verified: false, error};
    }
  }

  async canonize(input, {documentLoader, expansionMap, skipExpansion}) {
    return jsonld.canonize(input, {
      algorithm: 'URDNA2015',
      format: 'application/n-quads',
      documentLoader,
      expansionMap,
      skipExpansion,
      useNative: this.useNativeCanonize
    });
  }

  async canonizeProof(proof, {documentLoader, expansionMap}) {
    // `jws`,`signatureValue`,`proofValue` must not be included in the proof
    // options
    proof = {...proof};
    delete proof.jws;
    delete proof.signatureValue;
    delete proof.proofValue;
    return this.canonize(proof, {
      documentLoader,
      expansionMap,
      skipExpansion: false
    });
  }

  /**
   * @param document {object} to be signed/verified.
   * @param proof {object}
   * @param documentLoader {function}
   * @param expansionMap {function}
   * @param compactProof {boolean}
   *
   * @returns {Promise<{Uint8Array}>}.
   */
  async createVerifyData({
    document, proof, documentLoader, expansionMap}) {
    // concatenate hash of c14n proof options and hash of c14n document
    const c14nProofOptions = await this.canonizeProof(
      proof, {documentLoader, expansionMap});
    const c14nDocument = await this.canonize(document, {
      documentLoader,
      expansionMap
    });
    return util.concat(
      util.sha256(c14nProofOptions),
      util.sha256(c14nDocument));
  }

  /**
   * @param document {object} to be signed.
   * @param proof {object}
   * @param documentLoader {function}
   * @param expansionMap {function}
   */
  async getVerificationMethod({proof, documentLoader}) {
    let {verificationMethod} = proof;

    if(!verificationMethod) {
      // backwards compatibility support for `creator`
      const {creator} = proof;
      verificationMethod = creator;
    }

    if(typeof verificationMethod === 'object') {
      verificationMethod = verificationMethod.id;
    }

    if(!verificationMethod) {
      throw new Error('No "verificationMethod" or "creator" found in proof.');
    }

    const contexts = [constants.SECURITY_CONTEXT_URL];

    // adding missing jws context to use on the frame
    contexts.push("https://w3id.org/security/suites/jws-2020/v1");

    // Note: `expansionMap` is intentionally not passed; we can safely drop
    // properties here and must allow for it
    const {'@graph': [framed]} = await jsonld.frame(verificationMethod, {
      '@context': contexts,
      '@embed': '@always',
      id: verificationMethod
    }, {documentLoader, compactToRelative: false});
    if(!framed) {
      throw new Error(`Verification method ${verificationMethod} not found.`);
    }

    // ensure verification method has not been revoked
    if(framed.revoked !== undefined) {
      throw new Error('The verification method has been revoked.');
    }

    return framed;
  }

  /**
   * @param verifyData {Uint8Array}.
   * @param document {object} to be signed.
   * @param proof {object}
   * @param documentLoader {function}
   * @param expansionMap {function}
   *
   * @returns {Promise<{object}>} the proof containing the signature value.
   */
  async sign() {
    throw new Error('Must be implemented by a derived class.');
  }

  /**
   * @param verifyData {Uint8Array}.
   * @param verificationMethod {object}.
   * @param document {object} to be signed.
   * @param proof {object}
   * @param documentLoader {function}
   * @param expansionMap {function}
   *
   * @returns {Promise<boolean>}
   */
  async verifySignature() {
    throw new Error('Must be implemented by a derived class.');
  }
};
