/*!
 * Copyright (c) 2018 Digital Bazaar, Inc. All rights reserved.
 */
'use strict';

const api = {};
module.exports = api;

// TODO: only require dynamically as needed or according to build
api.suites = {
  LinkedDataProof: require("./suites/LinkedDataProof"),
  LinkedDataSignature: require("./suites/LinkedDataSignature"),

  // TODO: these are been removed from upstream. think they should be imported on demand
  Ed25519Signature2018: require("./suites/Ed25519Signature2018"),
  JwsLinkedDataSignature: require("./suites/JwsLinkedDataSignature"),
};
