const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const logger = require('morgan');
const cors = require('cors');
const CONF = require('./config');
const app = express();
const SRC_ROUTES = [
  'invoice2',
];
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const swaggerDocument = YAML.load('./swagger.yaml');

app.use(helmet());
app.use(cors());
app.use(logger('combined'));
app.use(cookieParser());
app.use(express.raw({ limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.startRoute = () => {
  SRC_ROUTES.forEach((v) => {
    app.use(`/${v}`, require(`./src/routes/${v}`));
  });
};

app.get('/', (req, res) => {
  res.send(CONF.server.host);
});

app.get('/ping', (req, res) => {
  res.send("It's live!!!");
});

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

module.exports = app;
