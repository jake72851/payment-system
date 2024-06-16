const mongoose = require('mongoose');

const invoiceSchema = mongoose.Schema(
  {
    //유저 정보
    userId: {
      type: String,
      required: true,
    },
    //템플릿 정보
    template: {
      type: String,
      ref: 'Template',
      default: null,
    },
    //디자인 정보
    design: {
      type: String,
      ref: 'Design',
      default: null,
    },
    // legacy 요금제 정보
    // 단건 - [0]
    // 월간 - [1,3,4,5,9]
    // 연간 - [2,6,7,8,10]
    planType: {
      type: Number,
      default: 0,
      required: true,
      // new 요금제 정보 (v2024.02)
      // 단건(무료 사용자) - [0] 시나리오 횟수 [3]
      // 베이직 월간 - [1, 2, 3] 시나리오 횟수 [100, 300, 500]
      // 베이직 연간 - [11, 12, 13] 시나리오 횟수 [100, 300, 500]
      // 엔터프라이즈 월간 - [101, 102, 103, 104, 105, 106, 107, 108, 109] 시나리오 횟수 [1000, 2000, 4000, 10000, 20000, 40000, 60000, 80000, 100000]
      // 엔터프라이즈 연간 - [111, 112, 113, 114, 115, 116, 117, 118, 119] 시나리오 횟수 [1000, 2000, 4000, 10000, 20000, 40000, 60000, 80000, 100000]
    },
    //쿠폰 정보
    coupon: {
      type: String,
      ref: 'Coupon',
      default: null,
    },
    //프로모션 정보
    promotion: {
      type: String,
      default: null,
    },
    //가격
    price: {
      type: Number,
      required: true,
      default: 0,
    },
    // 정상가
    regularPrice: {
      type: Number,
      default: 0,
    },
    // 요금제 변경 요청 - 1: 업그레이드, -1: 다운그레이드, 0: 변경 없음
    reqModifyPayment: {
      type: Number,
      default: 0,
    },
    monthlyScenarioGen: {
      type: Number,
      default: 0,
    },
    //서브템플릿 정보
    subtemplate: {
      type: String,
      ref: 'Subtemplate',
      default: null,
    },
    //PG사 영수증 ID
    pgReceiptId: {
      type: String,
      default: null,
    },
    //결제 상태
    //0-결제 대기 상태. 승인 나기 전의 상태, 1 - 결제 완료, -1 - 오류로 인해 결제 실패
    //20 - 결제 취소 , -20 - 결제 취소가 실패
    status: {
      type: Number,
      required: true,
      default: 0,
    },
    //결제 방법 - 카드,휴대폰,카카오페이,페이팔 등등
    method: {
      type: String,
      default: null,
    },
    //결제 유형 - 건당 - 0 / 월간 - 1 / 연간 - 2
    period: {
      type: Number,
      default: 0,
    },
    //상세정보 - 건당 결제, 베이직, 스탠다드, 프로 등
    detail: {
      type: String,
      default: null,
    },
    //영수증 URL
    receiptUrl: {
      type: String,
      default: null,
    },
    languageCode: {
      type: String,
      default: 'ko',
    },
    countryCode: {
      type: String,
    },
    bootpayVerifyResult: {
      type: Object,
      default: null,
      select: false,
    },
    bootpaySubscribeBilling: {
      type: Object,
      default: null,
      select: false,
    },
    paypleVerifyResult: {
      type: Object,
      default: null,
      select: false,
    },
    inappReceiptId: {
      type: String,
    },
    inappVerifyResult: {
      type: Object,
      default: null,
      select: false,
    },
    inappProductId: {
      type: String,
      default: null,
    },

    // 페이플 오류시 코드 저장
    // 참고 : https://www.notion.so/vplanet/851a91f05d1d4951801ebd2b708d8adf?pvs=4
    paypleErrCode: {
      type: String,
      default: null,
    },
    // snsUpload 추가 - 결제안함 0, 결제함 1
    snsUpload: {
      type: Number,
      default: 0,
    },
    // snsUpload 만 결제하는 경우 - 플랜이랑 같이 결제 0, snsUpload만 결제함 1
    snsUploadOnly: {
      type: Number,
      default: 0,
    },
    // snsUpload 기본 비용
    snsUploadPrice: {
      type: Number,
      default: 0,
    },
    // snsUpload 플랜 기본 비용 처리용
    planOriginPrice: {
      type: Number,
      default: 0,
    },
    // 24-05-20 추가
    currency: {
      type: String,
    },
  },
  {
    versionKey: false,
    timestamps: true,
  },
);

module.exports = mongoose.model('Invoice', invoiceSchema);
