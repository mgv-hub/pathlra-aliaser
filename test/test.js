"use strict";
const express = require("express");
const e = express();
require("../index")(); // pathlra-aliaser 4.6.11
const productController = require("@productController");
const userController = require("@userController");
const productsRoutes = require("@products");
const usersRoutes = require("@users");
const logs = require("@logger");

e.get("/", (req, res) => {
  res.send(`<h1>Welcome to Test Express Server</h1>
    <p>Server base URL <a href="http://localhost:3001" target="_blank">http://localhost:3001</a></p> 
  `);
});

e.use("/products", productsRoutes);
e.use("/users", usersRoutes);

logs.log("All modules loaded successfully");
console.log(
  "Users routes",
  usersRoutes.stack.map((r) => r.route?.path),
);
console.log(
  "Products routes",
  productsRoutes.stack.map((r) => r.route?.path),
);

e.listen(3001, () => logs.log(`Server http://localhost:3001`));
