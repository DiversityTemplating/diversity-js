/* global Buffer, exports */
var http  = require('q-io/http');
var reqId = 1;
var Q     = require('q');

var BACKEND_URL = 'https://davidstage.textalk.se/backend/jsonrpc/v1/';

exports.factory = function(webshop, language, auth, backendUrl) {
  if (backendUrl === undefined) { backendUrl = BACKEND_URL; }
  language = language || 'sv';
  var url = backendUrl + '?webshop=' + webshop + '&language=' + language;

  if (auth) {
    url += '&auth=' + auth;
  }

  return function(method, params) {

    var body = JSON.stringify({
      jsonrpc: '2.0',
      id: reqId++,
      method: method,
      params: params
    });

    var headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body, 'utf8')
    };

    var request = {
      url: url,
      charset: 'UTF-8',
      method: 'POST',
      headers: headers,
      body: [body]
    };
    console.log('Doing req', method, params);
    return http.request(request).then(function (response) {
      if (response.status !== 200) {
        console.log('Not 200',response)
        return Q.reject(response);
      }

      return response.body.read().then(function(r) {
        var res = JSON.parse(r);
        if (res.result !== undefined) {
          return res.result;
        }
        console.log('JSON RPC Error',r.error);
        return Q.reject(r.error);
      });
    });
  };
};

// require('./lib/api.js').call('https://davidstage.textalk.se/backend/jsonrpc/v1/?webshop=11011','Article.list',[true,{ limit: 1}])
