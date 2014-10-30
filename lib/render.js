/* global exports */
var path       = require('path');
var Mustache   = require('mustache');

exports.createContext = function(webshopUid, webshopUrl) {
  return {
    scripts: ['http://localhost:35729/livereload.js'],
    styles: [],
    modules: [],
    context: {
      'webshop_uid':  webshopUid,
      'backend_url': 'davidstage.textalk.se/backend/jsonrpc/v1/',
      'webshop_url': webshopUrl
    }
  };
};

exports.prefixFactory = function(folder) {
  return function(name, url) {
    if (url.indexOf('//') === 0 ||
        url.indexOf('http://') === 0 ||
        url.indexOf('https://') === 0) {
      return url;
    }

    return path.join(folder, name, url);
  };
};

exports.renderMustache = function(template, context) {
  context = context || {};
  //Add the lambdas we need
  context.lang = function() {
    return function(txt, render) {
      return render('{{=[[ ]]=}}' + txt.replace(/lang/g, 'sv'));
    };
  };
  context.currency = function() {
    return function(txt, render) {
      return render('{{=[[ ]]=}}' + txt.replace(/currency/g, 'SEK'));
    };
  };
  context.gettext = function() {
    return function(txt, render) {
      return render('{{=[[ ]]=}}' + txt);
    };
  };

  return Mustache.render(template, context);
};
