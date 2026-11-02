// TEST ONLY: node --import ./test/fixtures/stub-register.mjs → services/alibaba.js is the fixture
import { register } from "node:module";
register("./stub-hooks.mjs", import.meta.url);
