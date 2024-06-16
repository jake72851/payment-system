const mongoose = require('mongoose');
const { Schema } = require('mongoose');

const paymentPlanSchema = mongoose.Schema(
  {
    //요금제 이름
    name: {
      type: String,
      default: null,
      // 한국어 [건당 결제, 베이직, 엔터프라이즈] / 영어 [Pay per one piece, Basic, Enterprise ]
    },

    // KR, US
    countryCode: {
      type: String,
    },

    // 한국어 : [원, $, Rp] -> 페이플 지원 화폐가 USD, KRW, JPY로 [원, $]
    // 영어 : [₩, $, Rp] -> 페이플 지원 화폐가 USD, KRW, JPY로 [₩, $]
    currency: {
      type: String,
    },

    // GB 단위
    storage: {
      type: Number,
    },

    // 월 - monthly, 년 - annually
    periodType: {
      type: String,
    },

    // 플랜 타입 - basic, enterprise
    planType: {
      type: String,
    },

    // 활성화 상태 - 1: 활성, 0: 비활성
    status: {
      type: Number,
      default: 1,
    },

    // Basic: monthly [1, 2, 3], yearly [11, 12, 13] / Enterprise: monthly [101, 102, 103 ... 109], yearly [111, 112, 113 ... 119] -> 플랜 추가될 여지가 있으므로
    // plan에 대한 자유 형식
    // 플랜별 옵션으로 시나리오 횟수 차등 처리
    /*
    [
      {
        "type": 101,
        "volume": 1000,
        "price": 89
      }
    ]
    */
    scenario: {
      type: Array,
    },

    // sns upload 비용
    snsUploadPrice: {
      type: Number,
    },

    // sns upload 비용 (요금제 표시용)
    snsUpload: {
      type: Number,
    },

    // sns upload 할인정보 (요금제 표시용)
    snsUploadDiscountInfo: {
      type: Number,
    },
  },
  {
    versionKey: false,
    timestamps: true,
  },
);

module.exports = mongoose.model('paymentplans_v3', paymentPlanSchema);
