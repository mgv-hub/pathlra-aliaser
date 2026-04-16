'use strict';
const express = require('express');
const router_routes = express.Router();

router_routes.get('/', (req, res) => res.send('all products'));
router_routes.get('/:id', (req, res) => res.send(`Product ${req.params.id}`));

module.exports = router_routes;
