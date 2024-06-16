const express = require('express');
const router = express.Router();

const checkAuth = require('../middleware/check-auth');
const invoiceController = require('../controllers/invoice2');

// 요금제 전체 보여주기
router.get('/payment/plan', checkAuth, invoiceController.get_payment_plan);

// 요금제 가격 계산 로직
router.get('/price/:planType', checkAuth, invoiceController.subscriptionPrice);

// 유저가 보유한 쿠폰 리스트 출력
router.get('/coupon', checkAuth, invoiceController.user_coupon_box);

// 결제하기 -> 인보이스 생성 및 페이플 객체 반환 API
router.post('/payment/request', checkAuth, invoiceController.payplePayment);

// 페이플 카드 인증 결과 CERT 처리 및 redirection API - Desktop
router.post(
  '/payment/cert-pc/:invoiceId',
  invoiceController.payplePaymentResult,
);

// 페이플 카드 인증 결과 CERT 처리 및 redirection API - Mobile
router.post(
  '/payment/cert-mobile/:invoiceId',
  invoiceController.payplePaymentResult_Mobile,
);

// 페이플 GLOBAL 결제 결과 수신 및 redirection API
router.post(
  '/payment/global/:invoiceId',
  invoiceController.payplePaymentResult_GLOBAL,
);

// 부가서비스 해지
router.delete('/optionalService', checkAuth, invoiceController.optionalCancel);

//발급된 빌링키 취소하기
router.post('/billing/cancel', checkAuth, invoiceController.billingKey_cancel);

// 페이플 결제 결과 API
router.get('/payment/result/:invoiceId', invoiceController.paypleResultInvoice);

module.exports = router;
