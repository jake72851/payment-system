const mongoose = require('mongoose');

const couponboxSchema = mongoose.Schema(
  {
    coupon: {
      type: String,
      required: true,
      ref: 'Coupon',
    },
    userId: {
      type: String,
      required: true,
      ref: 'User',
    },
    status: {
      type: Boolean,
      default: true,
    },
  },
  {
    versionKey: false,
    timestamps: true,
  },
);

module.exports = mongoose.model('Coupon_box', couponboxSchema);

module.exports.exist = (userId, couponId) => {
  return new Promise((resolve, reject) => {
    try {
      module.exports
        .findOne({ userId: userId, coupon: couponId })
        .then((data) => {
          return resolve(!!data);
        });
    } catch (e) {
      console.error(e);
      return reject(e);
    }
  });
};
