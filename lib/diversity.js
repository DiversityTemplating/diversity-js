/* global Buffer, exports */
var http  = require('q-io/http');
var reqId = 1;
var Q     = require('q');



var callDiversity = function(diversityUrl, path) {
  var url = diversityUrl + path;

  var request = {
    url: url,
    charset: 'UTF-8',
    method: 'GET'
  };
  console.log('Doing req', url);
  var start = Date.now();
  return http.request(request).then(function(response) {
    if (response.status !== 200) {
      console.log('Not 200', url);
      return Q.reject(response);
    }

    return response.body.read().then(function(r) {
      console.log(path + ' took ', Date.now() - start);
      return r;
    });
  });
};

exports.get = callDiversity;

exports.getDiveristyJson = function(diversityUrl, name, version) {
  return callDiversity(diversityUrl, 'components/' + name + '/' + version + '/').then(function(data) {
    try {
      return JSON.parse(data);
    } catch (e) {
      console.log('Could not parse diversity.json');
      return Q.reject();
    }
  });
};

exports.getFile = function(diversityUrl, name, version, path) {
  return callDiversity(diversityUrl, 'components/' + name + '/' + version + '/files/' + path);
};
