const mongoose = require('mongoose');
const CouponBox = require('../models/coupon_box');
const CouponUse = require('../models/coupon_use');

const couponSchema = mongoose.Schema(
  {
    _id: String,
    //유저 정보를 위한 유저아이디
    userId: {
      type: String,
      ref: 'User',
    },
    //쿠폰 이름 (베이직 플랜 사용)
    title: {
      type: String,
      default: null,
    },
    //쿠폰 서브 이름 (MWC 2024)
    subtitle: {
      type: String,
      default: null,
    },
    //쿠폰 코드 하나로 여러명의 등록 및 사용 가능 여부
    reusability: {
      type: Boolean,
      default: false,
    },
    //할인 방식, percentage-%할인, money-금액
    type: {
      type: String,
      // enum: ['percent', 'money']
      enum: ['percent', 'money', 'term'],
    },
    //퍼센트 혹은 금액에 따른 할인 금액 숫자
    value: {
      type: Number,
      default: 100,
    },
    //쿠폰 만료 날짜
    expired: {
      type: Date,
      default: Date.now(),
      expires: '1m',
    },
    extendExpiredDays: {
      type: Number,
      default: null,
    },
    languageCode: {
      type: String,
      default: 'ko',
    },
    // 할인 가능한 요금제
    planType: {
      type: Number,
      default: 0,
    },
  },
  {
    versionKey: false,
    timestamps: true,
  },
);

module.exports = mongoose.model('Coupon', couponSchema);

// TODO : 왜 model 에 logic 이 있는 거지 이동 요망.
// 사용자 쿠폰함에 신규로 발행한 쿠폰 넣기
module.exports.coupon_box_input = (userId, couponId) => {
  return new Promise(async (resolve, reject) => {
    try {
      // 쿠폰 존재 여부 검사
      const coupon = await module.exports.findById(couponId);

      if (!coupon)
        return reject({
          code: 'COUPON_NOT_FOUND',
          message: 'coupon not found',
        });

      // 쿠폰 만료 날짜가 현재일 이상인 경우
      if (coupon.expired && coupon.expired < new Date())
        return reject({
          code: 'COUPON_IS_EXPIRED',
          message: 'coupon id expired',
        });

      // 박스 존재 여부 검사
      const existInBox = await CouponBox.exist(userId, couponId);
      if (existInBox)
        return reject({
          code: 'COUPON_ALREADY_EXISTS',
          message: 'coupon already exists',
        });
      if (couponId === '11111' || couponId === '22222') {
        const couponDate = new Date();
        coupon.created = couponDate;
        coupon.expired = couponDate.setMonth(couponDate.getMonth() + 1);
      }
      await coupon.save();
      // 쿠폰함에 저장
      const couponBox = new CouponBox({
        userId: userId,
        coupon: couponId,
      });
      await couponBox.save();
      //콘솔에 출력되는 값
      return resolve(couponBox);
    } catch (e) {
      console.log(e);
      return reject(e);
    }
  });
};

// TODO : 왜 model 에 logic 이 있는 거지 이동 요망.
// 쿠폰 사용함에 사용한 쿠폰 넣기
module.exports.coupon_use_input = (userId, couponId) => {
  return new Promise(async (resolve, reject) => {
    try {
      // 쿠폰 존재 여부 검사
      const coupon = await module.exports.findById(couponId);
      if (!coupon)
        return reject({
          code: 'COUPON_NOT_FOUND',
          message: 'coupon not found',
        });
      // 박스 존재 여부 검사
      const existInUse = await CouponUse.exist(userId, couponId);
      console.log(existInUse);
      if (existInUse)
        return reject({
          code: 'COUPON_ALREADY_USED',
          message: 'coupon already used',
        });

      // 쿠폰함에 저장
      const couponUse = new CouponUse({
        userId: userId,
        coupon: couponId,
      });
      await couponUse.save();
      //콘솔에 출력되는 값
      return resolve(couponUse);
    } catch (e) {
      console.log(e);
      return reject(e);
    }
  });
};
