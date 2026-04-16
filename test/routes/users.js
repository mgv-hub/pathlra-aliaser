'use strict';
const express = require('express');
const router_routes = express.Router();

router_routes.get('/', (req, res) => res.send('all users'));
router_routes.get('/:id', (req, res) => res.send(`User ${req.params.id}`));

module.exports = router_routes;
