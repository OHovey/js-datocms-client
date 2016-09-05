require('babel-polyfill');

import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import dirtyChai from 'dirty-chai';
import vcr from 'nock-vcr-recorder';

chai.use(chaiAsPromised);
chai.use(dirtyChai);

global.expect = expect;

function slugify(text) {
  return text.toString().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

global.vcr = function (...args) {
  const suffix = args.length > 1 ? ` ${args.shift()}` : '';
  const action = args[0];

  return function () {
    let cassetteName = (this.currentTest || this.test).fullTitle();
    if (suffix) { cassetteName += suffix; }
    return vcr.useCassette(slugify(cassetteName), action);
  };
};

