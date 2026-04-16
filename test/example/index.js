"use strict";

const pathlra_aliaser = require("pathlra-aliaser");
pathlra_aliaser();

const express = require("express");
const e = express();

const usersRoutes = require("@users");
const productsRoutes = require("@products");
const logs = require("@logger");

e.use("/users", usersRoutes);
e.use("/products", productsRoutes);

e.listen(3000, () => {
  logs.log("Server http://localhost:3000");
});