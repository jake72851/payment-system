const CONF = require('../../config');
const db = require('mongoose');

const Design = require('../models/design');
const Invoice = require('../models/invoice');
const Coupon = require('../models/coupon');
const CouponBox = require('../models/coupon_box');
const Subtemplate = require('../models/subtemplate');
const paymentPlan = require('../models/payment_plan');
const paymentplans_v3 = require('../models/paymentPlan_v3');
const User = require('../models/user');
const Subscription = require('../models/subscriptions');
const Promotion = require('../models/promotion');
const Reservation = require('../models/reservation');
const EmailSubscriptionNotice = require('../models/emailSubscriptionNotice');

const mailing = require('../utils/mailing');

const twilioClient = require('../../lib/twilioClient');
BootpayRest.setConfig(CONF.bootpay.applicationId, CONF.bootpay.privateKey);

const PaypleRest = require('../utils/payple2');

const jwt = require('jsonwebtoken');
const CryptoJS = require('crypto-js');
const schedule = require('node-schedule');
const moment = require('moment');
const momentTz = require('moment-timezone');
const axios = require('axios');

const utils = require('../utils/commonUtils');

const SINGLE_PAYMENT_DONE_URL =
  process.env.NODE_ENV == 'production'
    ? CONF.PAYPLE.paymentDoneUrl.production.single
    : CONF.PAYPLE.paymentDoneUrl.development.single;
const SUBSCRIPTION_PAYMENT_DONE_URL =
  process.env.NODE_ENV == 'production'
    ? CONF.PAYPLE.paymentDoneUrl.production.subscription
    : CONF.PAYPLE.paymentDoneUrl.development.subscription;
const CONTRACT_PAYMENT_DONE_URL =
  process.env.NODE_ENV == 'production'
    ? CONF.PAYPLE.paymentDoneUrl.production.contract
    : CONF.PAYPLE.paymentDoneUrl.development.contract;

// 정기 결제 메일링 테스트 처리
const SEND_MAIL_EXE = process.env.NODE_ENV == 'production' ? true : false;
// 결제 스케쥴링 테스트 처리
const SCHEDULE_EXE = process.env.NODE_ENV == 'production' ? true : false;

const basicMonthlyPlanType = [1, 2, 3];
const basicYearlyPlanType = [11, 12, 13];
const enterpriseMonthlyPlanType = [101, 102, 103, 104, 105, 106, 107, 108, 109];
const enterpriseYearlyPlanType = [111, 112, 113, 114, 115, 116, 117, 118, 119];

// 요금제 출력
exports.get_payment_plan = async (req, res) => {
  try {
    const { ref, naverMarketKey, country } = req.query;
    console.log('get_payment_plan > req.query =', req.query);
    if (!country) throw 'COUNTRY_INFO_NOT_FOUND';

    // 로그인 필수 아님
    const { userId } = req.userData;

    let validation = [];
    const naverMarketObj = jwt.decode(
      naverMarketKey,
      CONF.NAVER_SOLUTION_PUBLIC_KEY,
      { algorithms: ['RS256'] },
    );

    // 프론트에서 전달하는 프로모션 정보가 있다면 프로모션 정보 변환과 유효성 확인
    if (ref && ref.length > 0) {
      validation = CryptoJS.AES.decrypt(
        ref.replace(/\ /g, '+'),
        CONF.PROMOTION_SECRET_KEY,
      )
        .toString(CryptoJS.enc.Utf8)
        .split(' ');

      // vplate 프로모션이라면 예외처리
      if (validation && validation.length > 0 && validation[1] == 'vplate')
        validation = [];
      console.log('get_payment_plan > validation1 =', validation);
    }

    // 사용자가 로그인을한 경우라면 프로모션 데이터 저장
    if (userId) {
      const user = await User.findById(userId);

      // 사용자 정보, 국가 코드가 존재하고 KR이면서 프로모션 코드가 있는 경우 외부 플랫폼 추가 정보 저장
      if (
        user &&
        user.countryCode &&
        user.countryCode == 'KR' &&
        validation.length == 2
      ) {
        // 프로모션 진행시 도출되는 외부 플랫폼 사용자 정보 db저장
        if (validation[1] == 'naver' && naverMarketObj) {
          user.externals.naver = naverMarketObj;
        } else if (validation[1] == 'colosseum') {
          user.externals.colosseum = {
            landedAt: parseInt(validation[0]),
          };
        } else if (validation[1] == 'makeshop') {
          user.externals.makeshop = {
            landedAt: parseInt(validation[0]),
          };
        } else if (validation[1] == 'godomall') {
          user.externals.godomall = {
            landedAt: parseInt(validation[0]),
          };
        }

        // 기존에 프로모션 정보가 없거나 프로모션 비대상자라고 하면 사용자 정보 업데이트
        if (!user.ref || user.ref.status <= 0) {
          user.ref = {
            landedAt: new Date(parseInt(validation[0])),
            domain: validation[1],
            status: 0, // 0: 사용전(프로모션 대상자), 1: 사용중(프로모션으로 정기결제 진행중), 2: 프로모션 사용완료(프로모션 정기결제 후 만료), -1: 프로모션 비대상자
          };
        }
        await user.save();
        console.log('get_payment_plan > 로그인 사용자 프로모션 저장!');
      }

      // 사용자에게 프로모션정보가 있고 사용가능한 상태면
      if (
        user &&
        user.ref &&
        user.ref.landedAt &&
        (user.ref.status == 0 || user.ref.status == 1)
      ) {
        // 프로모션 베이직 요금제 사용전의 경우에 할인가 노출
        validation = [user.ref.landedAt, user.ref.domain];
      } else {
        console.log('ALEADY_USED_PROMOTION_OR_INVALID');
        validation = [];
      }
    }

    // 프론트 전달 국가코드로 해당 국가 요금제 확인 - 건당 요금제는 제외
    const findPaymentPlans = await paymentplans_v3.find({
      $and: [
        { status: 1 },
        { countryCode: country == 'KR' ? 'KR' : 'US' },
        { planType: { $nin: 'piece' } },
      ],
    });
    console.log('get_payment_plan > findPaymentPlans =', findPaymentPlans);

    // const freePlan = {}; // 프론트에서 관리중 - 차후 필요하면 백엔드 관리
    const basicPlan = {
      plans: {
        monthly: [],
        annually: [],
      },
      extraService: {
        monthly: {
          snsUpload: 0,
        },
        annually: {
          snsUpload: 0,
        },
      },
    };
    const enterprisePlan = {
      plans: {
        monthly: [],
        annually: [],
      },
      extraService: {
        monthly: {
          snsUpload: 0,
        },
        annually: {
          snsUpload: 0,
        },
      },
    };

    for (const planItem of findPaymentPlans) {
      if (planItem.planType === 'basic') {
        basicPlan.name = planItem.name;
        if (planItem.periodType === 'monthly') {
          const arr = await planData(planItem.scenario);
          basicPlan.plans.monthly.push(...arr);
          basicPlan.extraService.monthly.snsUpload = planItem.snsUploadPrice;
        } else if (planItem.periodType === 'annually') {
          const arr = await planData(planItem.scenario);
          basicPlan.plans.annually.push(...arr);
          basicPlan.extraService.annually.snsUpload = planItem.snsUploadPrice;
        }
        basicPlan.countryCode = planItem.countryCode;
        basicPlan.currency = planItem.currency;
        basicPlan.storage = planItem.storage;
      } else if (planItem.planType === 'enterprise') {
        enterprisePlan.name = planItem.name;
        if (planItem.periodType === 'monthly') {
          const arr = await planData(planItem.scenario);
          enterprisePlan.plans.monthly.push(...arr);
          enterprisePlan.extraService.monthly.snsUpload =
            planItem.snsUploadPrice;
        } else if (planItem.periodType === 'annually') {
          const arr = await planData(planItem.scenario);
          enterprisePlan.plans.annually.push(...arr);
          enterprisePlan.extraService.annually.snsUpload =
            planItem.snsUploadPrice;
        }
        enterprisePlan.countryCode = planItem.countryCode;
        enterprisePlan.currency = planItem.currency;
        enterprisePlan.storage = planItem.storage;
      }
    }

    if (country != 'KR') {
      validation = [new Date(parseInt(validation[0])), 'global'];
    }

    // 유효성은 위 초반 부분에 처리
    let promotions;
    if (validation.length == 2) {
      promotions = await Promotion.findOne({
        $and: [
          { domain: validation[1] },
          { currency: country == 'KR' ? 'KRW' : 'USD' },
        ],
      });
    }

    // 프로모션 정보 추가 - 차후 SnsUpload, storage 추가 가능성 있음
    if (promotions) {
      if (basicMonthlyPlanType.includes(promotions.planType)) {
        basicPlan.plans.monthly = await promotionApply(
          promotions,
          basicPlan.plans.monthly,
          country,
        );
        console.log(
          'get_payment_plan > basicPlan.plans.monthly =',
          basicPlan.plans.monthly,
        );
      } else if (basicYearlyPlanType.includes(promotions.planType)) {
        basicPlan.plans.annually = await promotionApply(
          promotions,
          basicPlan.plans.annually,
          country,
        );
        console.log(
          'get_payment_plan > basicPlan.plans.annually =',
          basicPlan.plans.annually,
        );
      } else if (enterpriseMonthlyPlanType.includes(promotions.planType)) {
        enterprisePlan.plans.monthly = await promotionApply(
          promotions,
          enterprisePlan.plans.monthly,
          country,
        );
        console.log(
          'get_payment_plan > enterprisePlan.plans.monthly =',
          enterprisePlan.plans.monthly,
        );
      } else if (enterpriseYearlyPlanType.includes(promotions.planType)) {
        enterprisePlan.plans.annually = await promotionApply(
          promotions,
          enterprisePlan.plans.annually,
          country,
        );
        console.log(
          'get_payment_plan > enterprisePlan.plans.annually =',
          enterprisePlan.plans.annually,
        );
      }
    }

    const resultJson = {};
    resultJson.basic = basicPlan;
    resultJson.enterprise = enterprisePlan;

    return res.json({
      code: 'SUCCESS',
      result: resultJson,
    });
  } catch (error) {
    console.log(error);
    return res.json({
      code: 'PAYMENT_PLAN_GET_ERROR',
      error,
    });
  }
};
// 플랜 데이터 처리
async function planData(plan) {
  const arr = plan.map((obj) => {
    const temp = {};
    temp.type = obj.type;
    temp.price = obj.price;
    temp.monthlyScenarioGen = obj.volume;
    if (obj.discountInfo) temp.discountInfo = obj.discountInfo;
    return temp;
  });

  return arr;
}
// 프로모션 데이터 처리
async function promotionApply(promo, plans, country) {
  const result = plans.map((obj) => {
    if (obj.type === promo.planType) {
      let resultPrice = 0;
      if (country === 'KR') {
        // 원화
        if (promo.discountType == 0) {
          // 할인 가격
          resultPrice = obj.price - promo.discountValue;
        } else if (promo.discountType == 1) {
          // 할인율
          resultPrice = obj.price * ((100 - promo.discountValue) * 0.01);
          // 소수점 제거
          resultPrice = Math.floor(resultPrice);
        }
      } else {
        // 달러 - 부동소수점 오류 보완
        const priceCent = Math.round(obj.price * 100); // 비용 달러 변환
        if (promo.discountType == 0) {
          // 할인 가격
          const discountValueCent = Math.round(promo.discountValue * 100); // 할인 비용 달러 변환
          resultPrice = priceCent - discountValueCent;
        } else if (promo.discountType == 1) {
          // 할인율
          resultPrice = priceCent * ((100 - promo.discountValue) * 0.01);
        }
        // 소수점 제거
        resultPrice = Math.floor(resultPrice);
        // 센트 변환
        resultPrice = resultPrice * 0.01;

        // 부동소수점 오류 발생 - 소수점 2자리까지만 처리
        resultPrice = resultPrice.toFixed(2);
      }

      return {
        ...obj,
        discount: {
          ref: promo.domain,
          price: resultPrice,
          discountType: promo.discountType,
        },
      };
    } else {
      return obj;
    }
  });

  return result;
}

/**
 * @param {string} userId
 * @returns { returnData }
 * @description 요금제 페이지 결재금액 산정 로직
 */
exports.subscriptionPrice = async (req, res) => {
  try {
    // 전처리
    const { userId } = req.userData;
    let { planType } = req.params;
    if (planType) planType = parseInt(planType);
    let { country, snsUpload } = req.query;

    if (snsUpload === 'true') {
      snsUpload = true;
    } else {
      snsUpload = false;
    }

    if (!userId || isNaN(planType) || !country) throw 'NEED_MORE_INPUT';

    // 결제하기 상세정보 처리 및 가격검증 처리 공통 함수
    const funcResult = await planDetailPriceVerify(
      userId,
      country,
      snsUpload,
      planType,
      null, // couponId - 결제하기 상세정보 페이지에서는 쿠폰정보가 없음
    );

    // 처리 완료
    return res.json({
      isSuccess: true,
      currency: funcResult.currency, // 화폐

      restRegularPriceOfPlan: funcResult.restRegularPriceOfPlan, // 플랜 기본 금액

      monthlyScenarioGen: funcResult.monthlyScenarioGen, // 요청한 요금제의 시나리오 횟수

      snsUploadPrice: funcResult.snsUploadPrice, // 부가 서비스 기본 금액, 0 이면 선택안함 표시

      planCal: funcResult.planCal, // 플랜 금액 일할 계산 비용
      remainingMonths: funcResult.remainingMonths, // 기존 요금제에서 사용전인 월 수
      remainingDays: funcResult.remainingDays, // 기존 요금제에서 사용전인 날짜 수

      snsUploadCal: funcResult.snsUploadCal, // 업로드 부가서비스 비용 일할계산

      discountPrice: funcResult.discountPrice, // 할인 총 금액
      discountInfos: funcResult.discountInfos, // 할인 항목 리스트

      resultPrice: funcResult.resultPrice, // 최종 결제 금액

      snsUpload: funcResult.snsUpload, // 업로드 부가서비스 여부
      reqModifyPayment: funcResult.reqModifyPayment, // 비용 검증용 - 신규 0, 업그레이드 1, 다운그레이드 -1
    });
  } catch (error) {
    console.log('subscriptionPrice() > error =', error);
    return res.json({
      isSuccess: false,
      msg: error,
    });
  }
};

// 결제하기 상세정보 처리 및 가격검증 동시 사용
async function planDetailPriceVerify(
  userId,
  country,
  snsUpload,
  planType,
  couponId,
  isContract,
) {
  // 언어코드 처리
  const countryCode = country == 'KR' ? 'KR' : 'US';
  // 금액 단위 처리
  const currency = countryCode == 'KR' ? 'KRW' : 'USD';

  // 사용자 유효성 확인
  const user = await User.findById(userId);
  // console.log('user =', user);
  if (!user) throw 'USER NOT FOUND';

  // 플랜 정보 확인
  const reqPlanInfo = await planInfo(planType, countryCode);
  // console.log('planDetailPriceVerify() > reqPlanInfo =', reqPlanInfo);
  if (!reqPlanInfo) throw 'PLAN INFO NOT FOUND';

  // 사용자가 snsUploadPrice = true (선택한경우)
  let snsUploadPrice = 0;
  if (snsUpload) snsUploadPrice = reqPlanInfo.snsUploadPrice;

  // 프로모션 정보 확인
  let ref;
  // 1. 사용자 db정보 기준 프로모션 적용여부 확인
  if (
    user.ref &&
    user.ref.domain != '' &&
    user.ref.landedAt &&
    (user.ref.status === 0 || user.ref.status === 1) && // 사용자의 프로모션 적용이 가능한 경우
    planType === 1 // 최종적으로 사용자가 현재 가능한 프로모션 플랜 1 을 요청하고 프로모션 페이지 링크로 접근한 경우에만 컨소시엄 프로모션을 적용한다
  ) {
    // 프로모션 유효성 확인
    const prmotionInfo = await Promotion.findOne({
      $and: [
        { domain: user.ref.domain },
        { planType: planType },
        { currency: currency },
        { expireDate: { $gt: new Date() } },
        { startDate: { $lte: new Date() } },
      ],
    });
    if (prmotionInfo) ref = user.ref.domain;
  }
  // 2. 영문 planType 1 인 경우 global 프로모션이 기본적으로 적용되어야함
  if (planType === 1 && countryCode === 'US') {
    ref = 'global';
  }

  if (isContract) {
    const contracts = await Contract.find({
      $and: [
        { status: 0 },
        { customer: userId },
        { invalidPasswordCnt: { $lt: 5 } },
        { expireDate: { $gt: new Date() } },
      ],
    }).sort({ createdAt: -1 });
    if (contracts && contracts.length > 0) {
      const prmotionInfo = await Promotion.findOne({
        domain: `${contracts[0]._id}_contract`,
      });
      if (prmotionInfo) ref = prmotionInfo.domain;
    }
  }

  const resData = {
    // flow 처리 여부
    consortiumResult: false, // 컨소시움 프로모션
    optionalServiceResult: false, // 기존에 유료 플랜을 사용하면서 동일 플랜에서 부가서비스만 추가되는 경우

    // 기본 정보
    ref: ref,
    planType: planType,
    currency: currency,
    userInfo: user,
    couponId: couponId, // 금액할인 쿠폰용 id
    countryCode: countryCode,
    period: reqPlanInfo.period, // 1: 월, 2: 년
    planName: reqPlanInfo.name, // 플랜명

    // 금액 정보
    restRegularPriceOfPlan: 0, // 결제금액
    monthlyScenarioGen: reqPlanInfo.scenarioVolume, // 월 시나리오 생성 횟수

    planCal: 0, // 플랜 금액 일할 계산 비용
    remainingMonths: 0, // 기존 요금제에서 사용전인 월 수 (년->년 기준)
    remainingDays: 0, // 기존 요금제에서 사용전인 날짜 수
    discountPrice: 0, // 할인 총 금액
    discountInfos: [], // 할인정보 저장
    discountType: 0, // 0: 가격, 1: 할인율
    resultPrice: 0, // 최종 결제 금액

    storage: reqPlanInfo.storage, // 저장 용량

    // 쿠폰 정보
    couponType: 0, // 할인 방식 - percentage : %할인 / money : 금액 / term : 기간
    couponSalePrice: 0, // 할인 금액
    // couponResultPrice: 0, // 할인 최종 금액

    // snsUpload 정보
    snsUpload: snsUpload, // 부가서비스(업로드) 선택 여부
    snsUploadPrice: snsUploadPrice, // 부가서비스(업로드) 비용 - 현재는 15000원 고정임
    snsUploadCal: 0, // 부가서비스 일할 계산
    snsUploadOnly: 0, // 부가서비스(업로드)만 결제하는 경우 - 0: 요금제와 함께 결제, 1: 부가서비스(업로드)만 결제

    // 만료일자
    // expiredDate: nowDay(),

    // invoice 요금처리 타입 - 변경없음 0, 업그레이드 1, 다운그레이드 -1
    reqModifyPayment: 0,
    // 비용 검증용 - 신규 0, 업그레이드 1, 다운그레이드 -1
    reqModifyPaymentInside: 0,

    // 비용 검증용 sns 업로드, 쿠폰 적용이전의 비용도 저장해봄
    resultPrice_sns_coupon: 0,

    // snsUpload 만 할시 기본비용 처리가 모호하여 추가함
    planOriginPrice: 0,
  };

  // 각 요금제 case를 확인하면서 진행
  let funcResult;

  // 1. 컨소시움 프로모션 처리 - 프로모션 정보가 있을때
  funcResult = await consortium(resData, reqPlanInfo);

  // 2. 컨소시움 프로모션이 아니고, 기존에 유료 플랜을 사용하면서 동일 플랜에서 부가서비스만 추가되는 경우 처리
  if (!funcResult.consortiumResult)
    funcResult = await optionalService(funcResult, reqPlanInfo);

  // 3. 위 2개 case가 아닌 경우 요금제 계산 시작
  if (!funcResult.consortiumResult && !funcResult.optionalServiceResult)
    funcResult = await payment(funcResult);

  // 4. 부가서비스 처리
  funcResult = await optionalServiceCal(funcResult, reqPlanInfo);

  // 5. 쿠폰 처리 - 쿠폰 id가 존재하고 기존 플랜에 부가서비만 변경하는게 아닌경우
  // if (couponId && !funcResult.optionalServiceResult) {
  if (couponId) {
    funcResult = await couponCal(funcResult, couponId);
  }

  // 6. 최종 계산
  funcResult = await finalCal(funcResult);

  return funcResult;
}
// 플렌정보 확인
async function planInfo(planType, countryCode) {
  // 플랜타입 체크 - 기타는 단건 결제
  const query = {};
  let period; // 아래 기간 처리시 필요 - 1: 월, 2: 년, 0: 단건결제
  if (basicMonthlyPlanType.includes(planType)) {
    query.planType = 'basic';
    query.periodType = 'monthly';
    period = 1;
  } else if (basicYearlyPlanType.includes(planType)) {
    query.planType = 'basic';
    query.periodType = 'annually';
    period = 2;
  } else if (enterpriseMonthlyPlanType.includes(planType)) {
    query.planType = 'enterprise';
    query.periodType = 'monthly';
    period = 1;
  } else if (enterpriseYearlyPlanType.includes(planType)) {
    query.planType = 'enterprise';
    query.periodType = 'annually';
    period = 2;
  } else {
    query.planType = 'piece';
    query.periodType = 'monthly';
    period = 0;
  }
  query.scenario = { $elemMatch: { type: planType } };
  // console.log('planInfo() > query =', query);

  const newPaymentPlan = await paymentplans_v3.findOne({
    $and: [{ status: 1 }, { countryCode: countryCode }, query],
  });
  // console.log('planInfo() > newPaymentPlan =', newPaymentPlan);

  const scenarioResult = await scenarioInfo(newPaymentPlan.scenario, planType);
  // console.log('planInfo() > scenarioGen =', scenarioGen);

  const response = {
    _id: newPaymentPlan._id,
    name: newPaymentPlan.name,
    countryCode: newPaymentPlan.countryCode,
    currency: newPaymentPlan.currency,
    storage: newPaymentPlan.storage,
    periodType: newPaymentPlan.periodType,
    planType: newPaymentPlan.planType,
    status: newPaymentPlan.status,
    scenarioVolume: scenarioResult.volume,
    scenarioPrice: scenarioResult.price,
    snsUploadPrice: newPaymentPlan.snsUploadPrice,
    period: period,
  };

  return response;
}
// 시나리오 정보 확인
async function scenarioInfo(scenario, planType) {
  const result = scenario.find((obj) => obj.type === planType);
  const response = {
    volume: result.volume,
    price: result.price,
  };
  return response;
}

// 1. 컨소시움 프로모션
async function consortium(resData, reqPlanInfo) {
  // 프로모션 있고 대상자일경우만 처리
  if (
    resData.ref &&
    (resData.userInfo.ref.status === 0 || resData.ref.includes('_contract'))
  ) {
    // 프로모션 유효성 확인
    const prmotionInfo = await Promotion.findOne({
      $and: [
        { domain: resData.ref },
        { planType: resData.planType },
        { currency: resData.currency },
        { expireDate: { $gt: new Date() } },
        { startDate: { $lte: new Date() } },
      ],
    });
    console.log('consortium() > prmotionInfo =', prmotionInfo);
    if (!prmotionInfo) throw 'REQUEST PROMOTION ERROR';

    // 기존에 이미 동일 프로모션 적용 여부?
    const oldInvoice = await Invoice.findOne({
      $and: [
        { userId: resData.userInfo._id },
        { planType: resData.planType },
        { promotion: resData.ref },
        { $or: [{ status: 1 }, { status: 20 }] }, // 결제가 완료되었거나 취소된 경우
      ],
    });
    console.log('consortium() > oldInvoice =', oldInvoice);
    if (oldInvoice) throw 'ALREADY PARTICIPATE PROMOTION';

    // 컨소시움 프로모션 할인정보 처리
    const promotionDiscResult = await promotionDiscCal(
      reqPlanInfo.scenarioPrice,
      prmotionInfo.discountType,
      prmotionInfo.discountValue,
      resData.countryCode,
    );

    // 결제금액
    resData.restRegularPriceOfPlan = reqPlanInfo.scenarioPrice;
    resData.planCal = reqPlanInfo.scenarioPrice; // 플랜 금액 일할 계산 비용
    // 할인 총 금액
    resData.discountPrice = Number(promotionDiscResult.salePrice);
    // 할인정보 저장
    resData.discountInfos.push({
      promotionName: prmotionInfo.domain + ' PROMOTION',
      discountPrice: Number(promotionDiscResult.salePrice),
    });
    // 할인 type - 0: 가격, 1: 할인율
    resData.discountType = prmotionInfo.discountType;
    // 최종 결제 금액
    resData.resultPrice = Number(promotionDiscResult.resultPrice);

    // 프로모션 적용시 true
    resData.consortiumResult = true;
  }
  return resData;
}
// 할인 금액 처리
async function promotionDiscCal(originPrice, discType, discVale, countryCode) {
  let resultPrice = 0;
  let resultSalePrice = 0;

  if (countryCode === 'KR') {
    // 1. 원화
    if (discType === 0) {
      resultSalePrice = discVale; // 할인 가격
      resultPrice = originPrice - discVale; // 플랜금액 - 할인금액
    } else if (discType === 1) {
      resultSalePrice = originPrice * (discVale * 0.01); // 할인율
      // 소수점 제거
      resultSalePrice = Math.floor(resultSalePrice);
      resultPrice = originPrice - resultSalePrice;
    }
  } else {
    // 2. 달러 - 부동소수점 오류 보완
    const originPriceCent = Math.round(originPrice * 100); // 비용 달러 변환
    if (discType === 0) {
      resultSalePrice = discVale; // 할인 가격
      const discountValueCent = Math.round(discVale * 100); // 할인 비용 달러 변환
      resultPrice = originPriceCent - discountValueCent; // 할인 가격
    } else if (discType === 1) {
      resultSalePrice = originPriceCent * (discVale * 0.01); // 할인율
      resultPrice = originPriceCent - resultSalePrice;

      resultSalePrice = Math.floor(resultSalePrice); // 소수점 제거
      resultSalePrice = resultSalePrice * 0.01; // 센트 변환
      resultSalePrice = resultSalePrice.toFixed(2); // 부동소수점 오류 발생 - 소수점 2자리까지만 처리
    }
    resultPrice = Math.floor(resultPrice); // 소수점 제거
    resultPrice = resultPrice * 0.01; // 센트 변환
    resultPrice = resultPrice.toFixed(2); // 부동소수점 오류 발생 - 소수점 2자리까지만 처리
  }

  return {
    salePrice: resultSalePrice, // 할인금액
    resultPrice: resultPrice, // 최종금액
  };
}

// 2. 기존 플랜과 요청 플랜이 동일하며 부가서비스만 추가되는 경우
async function optionalService(funcResult, reqPlanInfo) {
  // 기존 플랜이 없다면 신규 처리이므로 다음 요금제 변경 단계로 이동
  // 플랜정보 확인
  const invoiceInfo = await Invoice.findById(
    funcResult.userInfo.payment.invoiceId,
  );

  if (
    // 컨소시움이 아닌 경우
    !funcResult.consortiumResult &&
    // planType 유효성 체크
    invoiceInfo &&
    invoiceInfo.planType &&
    invoiceInfo.planType > 0 &&
    // 요청한 플랜과 기존 플랜이 같은지 확인
    invoiceInfo.planType === funcResult.planType &&
    // 기존에 snsUpload 정보가 없거나 결제내용에 snsUpload = false 인 경우
    (!funcResult.userInfo.snsUpload || funcResult.userInfo.snsUpload === 0) &&
    funcResult.snsUpload // 사용자가 부가서비스(업로드)를 신청한 경우
  ) {
    funcResult.planOriginPrice = reqPlanInfo.scenarioPrice;
    funcResult.optionalServiceResult = true;
    funcResult.reqModifyPayment = 0;
  }
  return funcResult;
}

// 3. 본격 요금제 시작
async function payment(funcResult) {
  // 프로모션 적용이 안되었고, 기존 플랜에 부가서비스만 변경되는 경우가 아닌경우
  if (!funcResult.consortiumResult && !funcResult.optionalServiceResult) {
    console.log('payment() >');
    console.log('payment() > 본격 요금제 시작!');
    // 기본적으로 모두 요금제 변경 개념으로 접근

    const countryCode = funcResult.countryCode;

    const reqPlanType = funcResult.planType;

    let lastPlanType = 0;
    if (
      funcResult.userInfo.payment &&
      funcResult.userInfo.payment.planType &&
      funcResult.userInfo.payment.planType > 0 &&
      funcResult.userInfo.payment.invoiceId
    ) {
      // 플랜정보 확인
      const invoiceInfo = await Invoice.findById(
        funcResult.userInfo.payment.invoiceId,
      );
      lastPlanType = invoiceInfo.planType;
    }

    const reqPlanInfo = await planInfo(reqPlanType, countryCode);
    console.log('payment() > reqPlanInfo =', reqPlanInfo);

    let lastPlanInfo;
    if (lastPlanType > 0) {
      lastPlanInfo = await planInfo(lastPlanType, countryCode);
    } else {
      lastPlanInfo = {
        period: 0,
        planType: 0,
        scenarioVolume: 3,
        scenarioPrice: 0,
      };
    }

    // 같은 플렌 불가
    if (reqPlanType === lastPlanType)
      throw 'INVALID PLATYPE - CAN NOT CHANGE TO SAME PLAN';

    // Bc : 이전 플랜 금액
    let Bc;

    // 업그레이드 or 다운그레이드 확인 및 전처리
    // 월 -> 연 : 업그레이드, 시나리오가 높으면 업그레이드
    // * 기간(월,년)과 타입(베이직,엔터) 둘 중에 하나라도 다운그레이드면 최종비용과 상관없이 다운그레이드
    if (lastPlanType === 0) {
      // 1. 신규
      funcResult.reqModifyPaymentInside = 0; // 비용 검증용 - 신규 0, 업그레이드 1, 다운그레이드 -1
    } else {
      // 2. 신규가 아니라면 기존
      if (
        lastPlanInfo.period > reqPlanInfo.period ||
        (lastPlanInfo.planType === 'enterprise' &&
          reqPlanInfo.planType === 'basic') ||
        (lastPlanInfo.period === reqPlanInfo.period &&
          lastPlanInfo.scenarioVolume > reqPlanInfo.scenarioVolume)
      ) {
        // 2-1. 다운그레이드
        // 기간(월,년)과 타입(베이직,엔터) 둘 중에 하나라도 다운그레이드
        // 기간(월,년)이 같고 변경 시나리오 횟수가 작으면 다운그레이드
        Bc = 0; // Bc : 이전 플랜 금액
        funcResult.reqModifyPaymentInside = -1;
      } else {
        // 2-2. 업그레이드
        Bc = lastPlanInfo.scenarioPrice; // Bc : 이전 플랜 금액
        funcResult.reqModifyPaymentInside = 1;
      }
    }

    if (funcResult.reqModifyPaymentInside === 0) {
      console.log('payment() > 신규');
      funcResult.restRegularPriceOfPlan = reqPlanInfo.scenarioPrice; // 플랜 기본 금액
      funcResult.planCal = reqPlanInfo.scenarioPrice; // 플랜 금액 일할 계산 비용
      funcResult.remainingMonths = 0; // 기존 요금제에서 사용전인 월 수 (년->년 기준)
      funcResult.remainingDays = 0; // 기존 요금제에서 사용전인 날짜 수
      funcResult.resultPrice = reqPlanInfo.scenarioPrice; // 최종 금액
      funcResult.reqModifyPayment = 0;
    } else if (funcResult.reqModifyPaymentInside === 1) {

      if (reqPlanInfo.period === 2 && lastPlanInfo.period === 1) {
        console.log('payment() > 월 -> 년 변경');

        // 월 엔터의 최대와 년 엔터의 최소시나리오 적용시 마이너스 금액 발생
        // 따라서 위 케이스만 미리 금액을 산정하여 업, 다운그레이드를 판단한다
        if (
          reqPlanInfo.periodType === 'annually' &&
          lastPlanInfo.periodType === 'monthly' &&
          reqPlanInfo.planType === 'enterprise' &&
          lastPlanInfo.planType === 'enterprise'
        ) {
          console.log('payment() > 마이너스 금액 확인');
          const priceResult = await monthToYearCalOnlyPrice(
            Bc,
            reqPlanInfo,
            funcResult,
          );
          if (priceResult) {
            console.log('payment() > 마이너스 금액 확인 > 업그레이드');
            funcResult = await monthToYearCal(Bc, reqPlanInfo, funcResult);
            funcResult.reqModifyPayment = 0;
          } else {
            console.log('payment() > 마이너스 금액 확인 > 다운그레이드');
            // 기존 플랜이 끝난후에 반영 > 다음 결제에 대한 정보만 변경
            funcResult.restRegularPriceOfPlan = reqPlanInfo.scenarioPrice; // 플랜 기본 금액
            funcResult.planCal = reqPlanInfo.scenarioPrice; // 플랜 금액 일할 계산 비용
            funcResult.remainingMonths = 0; // 기존 요금제에서 사용전인 월 수 (년->년 기준)
            funcResult.remainingDays = 0; // 기존 요금제에서 사용전인 날짜 수
            funcResult.resultPrice = reqPlanInfo.scenarioPrice; // 최종 금액
            funcResult.reqModifyPayment = -1;
          }
        } else {
          funcResult = await monthToYearCal(Bc, reqPlanInfo, funcResult);
          funcResult.reqModifyPayment = 0;
        }
      } else if (reqPlanInfo.period === 1 && lastPlanInfo.period === 1) {
        funcResult = await monthToMonthCal(Bc, reqPlanInfo, funcResult);
        funcResult.reqModifyPayment = 1;
      } else if (reqPlanInfo.period === 2 && lastPlanInfo.period === 2) {
        funcResult = await yearToYearCal(Bc, reqPlanInfo, funcResult);
        funcResult.reqModifyPayment = 1;
      }
    } else {
      console.log('payment() > 다운그레이드');
      // 기존 플랜이 끝난후에 반영 > 다음 결제에 대한 정보만 변경
      funcResult.restRegularPriceOfPlan = reqPlanInfo.scenarioPrice; // 플랜 기본 금액
      funcResult.planCal = reqPlanInfo.scenarioPrice; // 플랜 금액 일할 계산 비용
      funcResult.remainingMonths = 0; // 기존 요금제에서 사용전인 월 수 (년->년 기준)
      funcResult.remainingDays = 0; // 기존 요금제에서 사용전인 날짜 수
      funcResult.resultPrice = reqPlanInfo.scenarioPrice; // 최종 금액
      funcResult.reqModifyPayment = -1;
    }

    // 처리완료
    return funcResult;
  }
  return funcResult;
}
// * 월 -> 년 전환 계산
async function monthToYearCal(Bc, reqPlanInfo, funcResult) {
  // 월 -> 년 - (결제일 기준 새로 년 기간 시작) 기존 월 플랜의 남은 기간, 신규 년 플랜의 12개월 기준

  // Bc : 기존 플랜 금액 (이전 단계에서 처리해서 전달 받음)
  // Ac : 변경 플랜 금액
  // Md : 해당 월의 총 일수 (기존 플랜 기간 기준)
  // Ct : 기존 월 플랜 미사용 일수

  const Ac = reqPlanInfo.scenarioPrice;

  // 기존 월 플랜의 미사용 기간
  const subscriptionEnd = funcResult.userInfo.payment.subscriptionExpire;
  const Md = await subscriptionTotalDays(
    funcResult.userInfo.payment.period,
    subscriptionEnd,
  ); // 기존 월 플랜의 구독 기간 기준 총일수
  const Ct = await subscriptionUnuseDays(subscriptionEnd); // 기존 월 플랜의 미사용 일수

  let finalRestPrice;
  if (funcResult.countryCode === 'KR') {
    // 원화 - 소수점 제거 및 1단위 반올림
    const finalRest = Ac - (Ct / Md) * Bc;
    finalRestPrice = Math.floor(finalRest);
  } else {
    // 달러 - 소수점 3자리부터 제거 및 반올림
    // 달러 변환
    const Bc1 = Math.round(Bc * 100);
    const Ac1 = Math.round(Ac * 100);
    const finalRest = Ac1 - (Ct / Md) * Bc1;
    finalRestPrice = Math.floor(finalRest) * 0.01;
  }

  funcResult.restRegularPriceOfPlan = reqPlanInfo.scenarioPrice; // 플랜 기본 금액
  funcResult.planCal = finalRestPrice; // 플랜 금액 일할 계산 비용
  funcResult.remainingMonths = 12;
  funcResult.remainingDays = Ct;
  funcResult.discountPrice = finalRestPrice - reqPlanInfo.scenarioPrice;
  funcResult.discountInfos.push({
    promotionName: 'REMAINDER',
    discountPrice: finalRestPrice - reqPlanInfo.scenarioPrice,
  });
  funcResult.resultPrice = finalRestPrice;

  return funcResult;
}
// * 월 -> 년 전환 금액만 계산
async function monthToYearCalOnlyPrice(Bc, reqPlanInfo, funcResult) {
  // 월 -> 년 - (결제일 기준 새로 년 기간 시작) 기존 월 플랜의 남은 기간, 신규 년 플랜의 12개월 기준

  // Bc : 기존 플랜 금액 (이전 단계에서 처리해서 전달 받음)
  // Ac : 변경 플랜 금액
  // Md : 해당 월의 총 일수 (기존 플랜 기간 기준)
  // Ct : 기존 월 플랜 미사용 일수

  const Ac = reqPlanInfo.scenarioPrice;

  // 기존 월 플랜의 미사용 기간
  const subscriptionEnd = funcResult.userInfo.payment.subscriptionExpire;
  const Md = await subscriptionTotalDays(
    funcResult.userInfo.payment.period,
    subscriptionEnd,
  ); // 기존 월 플랜의 구독 기간 기준 총일수
  const Ct = await subscriptionUnuseDays(subscriptionEnd); // 기존 월 플랜의 미사용 일수

  let finalRestPrice;
  if (funcResult.countryCode === 'KR') {
    // 원화 - 소수점 제거 및 1단위 반올림
    const finalRest = Ac - (Ct / Md) * Bc;
    finalRestPrice = Math.floor(finalRest);
  } else {
    // 달러 - 소수점 3자리부터 제거 및 반올림
    // 달러 변환
    const Bc1 = Math.round(Bc * 100);
    const Ac1 = Math.round(Ac * 100);
    const finalRest = Ac1 - (Ct / Md) * Bc1;
    finalRestPrice = Math.floor(finalRest) * 0.01;
  }

  let response = true;
  if (finalRestPrice < 0) response = false;

  return response;
}
// 플랜의 총 일수 (구독 기간 기준)
async function subscriptionTotalDays(period, endDay) {
  let startDate;
  // 1: 월, 2: 년
  if (period === 1) {
    startDate = moment(endDay).subtract(1, 'month');
  } else if (period === 2) {
    startDate = moment(endDay).subtract(1, 'year');
  }
  const endDate = moment(endDay);
  const diffDays = endDate.diff(startDate, 'days');
  return diffDays;
}
// 플랜의 미사용 일수 (구독 기간 기준)
async function subscriptionUnuseDays(endDay) {
  const now = moment();
  const endDate = moment(endDay);
  const diffDays = endDate.diff(now, 'days');
  return diffDays;
}
// * 월 -> 월 전환 계산
async function monthToMonthCal(Bc, reqPlanInfo, funcResult) {
  // 월 -> 월 - (기존 플랜 기간 유지) 기존 플랜 종료일 기준 총 일수

  // Bc : 기존 플랜 금액 (이전 단계에서 처리해서 전달 받음)
  // Ac : 변경 플랜 금액
  // Md : 해당 월의 총 일수 (기존 플랜 기간 기준)
  // Ct : 기존 월 플랜 미사용 일수

  const Ac = reqPlanInfo.scenarioPrice;

  // 기존 월 플랜의 미사용 기간
  const subscriptionEnd = funcResult.userInfo.payment.subscriptionExpire;
  const Md = await subscriptionTotalDays(
    funcResult.userInfo.payment.period,
    subscriptionEnd,
  ); // 기존 월 플랜의 구독 기간 기준 총일수
  const Ct = await subscriptionUnuseDays(subscriptionEnd); // 기존 월 플랜의 미사용 일수

  // 구독 기간은 변경이 없기때문에
  // 변경 플랜의 미사용 일수의 비용 - 기존 플랜의 미사용 일수의 비용
  let finalRestPrice;
  if (funcResult.countryCode === 'KR') {
    // 원화 - 소수점 제거 및 1단위 반올림
    const finalRest = (Ct / Md) * Ac - (Ct / Md) * Bc;
    finalRestPrice = Math.floor(finalRest);
  } else {
    // 달러 - 소수점 3자리부터 제거 및 반올림
    // 달러 변환
    const Bc1 = Math.round(Bc * 100);
    const Ac1 = Math.round(Ac * 100);
    const finalRest = (Ct / Md) * Ac1 - (Ct / Md) * Bc1;
    finalRestPrice = Math.floor(finalRest) * 0.01;
  }

  funcResult.restRegularPriceOfPlan = reqPlanInfo.scenarioPrice; // 플랜 기본 금액
  funcResult.planCal = finalRestPrice; // 플랜 금액 일할 계산 비용
  funcResult.remainingMonths = 0;
  funcResult.remainingDays = Ct;
  funcResult.discountPrice = finalRestPrice - reqPlanInfo.scenarioPrice;
  funcResult.discountInfos.push({
    promotionName: 'REMAINDER',
    discountPrice: finalRestPrice - reqPlanInfo.scenarioPrice,
  });
  funcResult.resultPrice = finalRestPrice;

  return funcResult;
}
// * 년 -> 년 전환 계산
async function yearToYearCal(Bc, reqPlanInfo, funcResult) {
  // 구독 기간은 변경이 없기때문에 위 방식들로 처리가 모호함. 따라서 일 기준 금액 방식으로 적용함
  // (변경 년 플랜의 미사용 일 수 * 변경 년 플랜의 1일 기준 비용) - (기존 년 플랜의 미사용 일 수 * 기존 년 플랜의 1일 기준 비용)

  // Bc : 기존 년 플랜 금액 (이전 단계에서 처리해서 전달 받음)
  // Ac : 변경 년 플랜 금액
  // Bd : 기존 년 플랜의 1일 기준 비용
  // Ad : 변경 년 플랜의 1일 기준 비용
  // Md : 플랜의 총 일수 (기존 플랜 기간 기준)
  // Ct : 기존 년 플랜 미사용 일수

  let Ac = reqPlanInfo.scenarioPrice;

  // 기존 년 플랜의 미사용 기간
  const subscriptionEnd = funcResult.userInfo.payment.subscriptionExpire;
  const Md = await subscriptionTotalDays(
    funcResult.userInfo.payment.period,
    subscriptionEnd,
  ); // 기존 년 플랜의 구독 기간 기준 총일수
  const Ct = await subscriptionUnuseDays(subscriptionEnd); // 기존 월 플랜의 미사용 일수

  // 일 기준 비용
  const Bd = Bc / Md;
  const Ad = Ac / Md;

  let finalRestPrice;
  if (funcResult.countryCode === 'KR') {
    // 원화 - 소수점 제거
    const finalRest = Ct * Ad - Ct * Bd;
    finalRestPrice = Math.floor(finalRest);
  } else {
    // 달러 - 소수점 3자리부터 제거 및 반올림
    // 달러 변환 - Bd, Ad 부터 적용
    const Bd1 = Math.round(Bd * 100);
    const Ad1 = Math.round(Ad * 100);
    // 1일 비용 산정
    const Bd2 = Bd1 / Md;
    const Ad2 = Ad1 / Md;
    // 소수점 제거
    const Bd3 = Math.floor(Bd2);
    const Ad3 = Math.floor(Ad2);
    const finalRest = Ct * Ad3 - Ct * Bd3;
    finalRestPrice = Math.floor(finalRest) * 0.01;
  }

  funcResult.restRegularPriceOfPlan = reqPlanInfo.scenarioPrice; // 플랜 기본 금액
  funcResult.planCal = finalRestPrice; // 플랜 금액 일할 계산 비용
  funcResult.remainingMonths = await oldPlanRemainMonth(subscriptionEnd);
  funcResult.remainingDays = Ct;
  funcResult.discountPrice = finalRestPrice - reqPlanInfo.scenarioPrice;
  funcResult.discountInfos.push({
    promotionName: 'REMAINDER',
    discountPrice: finalRestPrice - reqPlanInfo.scenarioPrice,
  });
  funcResult.resultPrice = finalRestPrice;

  return funcResult;
}

// 4. 부가서비스 계산 시작
async function optionalServiceCal(funcResult, reqPlanInfo) {
  // 부가서비스는 요금제 페이지에선 사용중일때는 변경할수 없음
  // 미사용에서 사용만 가능
  // 마이페이지에서만 해지 가능
  // 플랜과 동일하게 년 단위는 80% 할인

  let lastPlanType = 0;
  let lastSnsUploadPrice = 0;
  if (
    funcResult.userInfo.payment &&
    funcResult.userInfo.payment.planType &&
    funcResult.userInfo.payment.planType > 0 &&
    funcResult.userInfo.payment.invoiceId
  ) {
    // 플랜정보 확인
    const invoiceInfo = await Invoice.findById(
      funcResult.userInfo.payment.invoiceId,
    );
    lastPlanType = invoiceInfo.planType;
    lastSnsUploadPrice = invoiceInfo.snsUploadPrice;
  }

  if (lastPlanType === 0 && funcResult.snsUpload) {
    // 무료 플랜 사용중이고 부가서비스 신청
    if (reqPlanInfo.period === 1) {
      // 월 플랜이면
      funcResult.snsUploadCal = funcResult.snsUploadPrice;
    } else {
      // 년 플랜이면
      funcResult.snsUploadCal = funcResult.snsUploadPrice;
    }
  } else if (lastPlanType > 0) {
    // 기존 유료 플랜 사용중일때

    // 환불조건 확인
    // 1. snsUpload 사용여부
    const snsUploadUseCheck = await Reservation.findOne({
      userId: funcResult.userInfo._id,
    });
    // 2. 결제일 기준 7일 이내 여부
    const subscriptionStart = funcResult.userInfo.payment.subscriptionStart;
    const paymentCheck = await payment7DayIn(subscriptionStart);
    // 3. 최종 처리
    let refundCheck = false;
    // 기존에 사용내역이 없고 7일이내면 환불가능 (기존 부가서비스의 미사용 일할 계산 가능)
    if (!snsUploadUseCheck && paymentCheck) refundCheck = true;

    if (funcResult.optionalServiceResult) {
      // 1. 플랜이 동일하고 부가서비스만 신청하는 경우
      if (
        reqPlanInfo.period === 1 &&
        funcResult.userInfo.payment.period === 1
      ) {
        funcResult = await optionalMonthToMonthCal(
          reqPlanInfo,
          funcResult,
          0, // 기존 부가서비스 금액
          refundCheck,
        );
      } else if (
        reqPlanInfo.period === 2 &&
        funcResult.userInfo.payment.period === 2
      ) {
        funcResult = await optionalYearToYearCal(
          reqPlanInfo,
          funcResult,
          0, // 기존 부가서비스 금액
          refundCheck,
        );
      } else {
        throw 'SAME PLAN SNS UPLOAD CALCULATE ERROR';
      }
    } else if (
      !funcResult.optionalServiceResult &&
      funcResult.reqModifyPaymentInside != -1
    ) {
      // 2. 플랜이 서로 다른 경우
      if (
        funcResult.userInfo.payment.period === 1 &&
        reqPlanInfo.period === 2
      ) {
        // 월 엔터의 최대와 년 엔터의 최소시나리오 적용시 마이너스 금액 발생
        // 따라서 앞 단계에서 확인한 funcResult.reqModifyPayment = -1 를 기준으로 한다.
        if (funcResult.reqModifyPayment === -1) {
          console.log('optionalServiceCal() > 월 -> 년 변경 > 다운그레이드');
          funcResult = await optionalDowngradeCal(
            reqPlanInfo,
            funcResult,
            lastSnsUploadPrice, // 기존 부가서비스 금액
            refundCheck,
          );
        } else {
          console.log('optionalServiceCal() > 월 -> 년 변경 > 업그레이드');
          funcResult = await optionalMonthToYearCal(
            reqPlanInfo,
            funcResult,
            lastSnsUploadPrice, // 기존 부가서비스 금액
            refundCheck,
          );
        }
      } else if (
        funcResult.userInfo.payment.period === 1 &&
        reqPlanInfo.period === 1
      ) {
        console.log('optionalServiceCal() > 월 -> 월 변경');
        funcResult = await optionalMonthToMonthCal(
          reqPlanInfo,
          funcResult,
          lastSnsUploadPrice, // 기존 부가서비스 금액
          refundCheck,
        );
      } else if (
        funcResult.userInfo.payment.period === 2 &&
        reqPlanInfo.period === 2
      ) {
        console.log('optionalServiceCal() > 년 -> 년 변경');
        funcResult = await optionalYearToYearCal(
          reqPlanInfo,
          funcResult,
          lastSnsUploadPrice, // 기존 부가서비스 금액
          refundCheck,
        );
      }
    } else {
      // 3. 다운그레이드의 경우
      console.log('optionalServiceCal() > 년 -> 월 다운그레이드 변경');
      funcResult = await optionalDowngradeCal(
        reqPlanInfo,
        funcResult,
        lastSnsUploadPrice, // 기존 부가서비스 금액
        refundCheck,
      );
    }
  }

  return funcResult;
}
// 결제일 기준 7일이내 확인 (구독 시작 기준)
async function payment7DayIn(startDay) {
  const now = moment();
  const endDate = moment(startDay);
  const diffDays = endDate.diff(now, 'days');
  if (diffDays > 7) {
    return false;
  } else {
    return true;
  }
}

// * 월 -> 월 부가서비스 계산
async function optionalMonthToMonthCal(
  reqPlanInfo,
  funcResult,
  Bc,
  refundCheck,
) {
  // 월 -> 월 - (기존 플랜 기간 유지) 기존 플랜 종료일 기준 총 일수

  // Up : 변경 월 부가서비스 비용
  // Bc : 기존 월 부가서비스 비용
  // Md : 해당 월의 총 일수 (기존 플랜 기간 기준)
  // Ct : 기존 월 부가서비스 미사용 일수

  const Up = funcResult.snsUploadPrice; // 사용자 미신청시 0

  // 기존 월 부가서비스 미사용 기간
  const subscriptionEnd = funcResult.userInfo.payment.subscriptionExpire;
  const Md = await subscriptionTotalDays(
    funcResult.userInfo.payment.period,
    subscriptionEnd,
  ); // 기존 월 플랜의 구독 기간 기준 총일수
  const Ct = await subscriptionUnuseDays(subscriptionEnd); // 기존 월 플랜의 미사용 일수

  // 구독 기간은 변경이 없기때문에 환불조건에 따라 미사용 일수만 일할 계산
  let finalRestPrice;
  if (funcResult.countryCode === 'KR') {
    // 기존에 사용내역이 없고 7일이내면 환불가능 (기존 부가서비스의 미사용 일할 계산 가능)
    let finalRest;
    if (refundCheck) {
      finalRest = (Ct / Md) * Up - (Ct / Md) * Bc;
    } else {
      finalRest = (Ct / Md) * Up;
    }
    // 원화 - 소수점 제거 및 1단위 반올림
    finalRestPrice = Math.floor(finalRest);

  } else {
    // 달러 - 소수점 3자리부터 제거 및 반올림
    // 달러 변환
    const Up1 = Math.round(Up * 100);
    const Bc1 = Math.round(Bc * 100);
    // 기존에 사용내역이 없고 7일이내면 환불가능 (기존 부가서비스의 미사용 일할 계산 가능)
    let finalRest;
    if (refundCheck) {
      finalRest = (Ct / Md) * Up1 - (Ct / Md) * Bc1;
    } else {
      finalRest = (Ct / Md) * Up1;
    }
    finalRestPrice = Math.floor(finalRest) * 0.01;
  }

  if (funcResult.optionalServiceResult) {
    // 1. 플랜이 동일하고 부가서비스만 신청하는 경우
    funcResult.restRegularPriceOfPlan = 0; // 플랜 기본 금액

    // 기존에 사용내역이 없고 7일이내면 환불가능 (기존 부가서비스의 미사용 일할 계산 가능)
    if (refundCheck) {
      funcResult.remainingMonths = 0;
      funcResult.remainingDays = Ct;
      funcResult.discountPrice = finalRestPrice - reqPlanInfo.snsUploadPrice;
      funcResult.discountInfos.push({
        promotionName: 'REMAINDER',
        discountPrice: finalRestPrice - reqPlanInfo.snsUploadPrice,
      });
      // funcResult.discountType = 0; // 전처리
    }
    funcResult.snsUploadCal = finalRestPrice;
    funcResult.snsUploadOnly = 1; // 부가서비스(업로드)만 결제하는 경우 1
  } else {
    // 2. 일반 케이스의 경우
    funcResult.snsUploadCal = finalRestPrice;
  }

  return funcResult;
}
// * 년 -> 년 부가서비스 계산
async function optionalYearToYearCal(reqPlanInfo, funcResult, Bc, refundCheck) {
  // 구독 기간은 변경이 없기때문에 일반 월 기준 방식으로 처리가 모호함. 따라서 일 기준 금액 방식으로 적용함
  // 환불이 가능한 경우
  // - (변경 년 부가서비스의 미사용 일 수 * 변경 년 부가서비스의 1일 기준 비용) - (기존 년 부가서비스의 미사용 일 수 * 기존 년 부가서비스의 1일 기준 비용)
  // 환불이 불가능한 경우
  // - (변경 년 부가서비스의 미사용 일 수 * 변경 년 부가서비스의 1일 기준 비용)

  // Bc : 기존 년 부가서비스의 12개월 총 금액 (이전 단계에서 처리해서 전달 받음)
  // Ac : 변경 년 부가서비스의 12개월 총 금액
  // Bd : 기존 년 부가서비스의 1일 기준 비용
  // Ad : 변경 년 부가서비스의 1일 기준 비용
  // Md : 부가서비스의 총 일수 (기존 플랜 기간 기준)
  // Ct : 기존 년 부가서비스의 미사용 일수

  const Ac = funcResult.snsUploadPrice;

  // 기존 년 플랜의 미사용 기간
  const subscriptionEnd = funcResult.userInfo.payment.subscriptionExpire;
  const Md = await subscriptionTotalDays(
    funcResult.userInfo.payment.period,
    subscriptionEnd,
  ); // 기존 년 플랜의 구독 기간 기준 총일수
  const Ct = await subscriptionUnuseDays(subscriptionEnd); // 기존 월 플랜의 미사용 일수

  // 일 기준 비용
  const Bd = Bc / Md;
  const Ad = Ac / Md;

  let finalRestPrice;
  if (funcResult.countryCode === 'KR') {
    // 기존에 사용내역이 없고 7일이내면 환불가능 (기존 부가서비스의 미사용 일할 계산 가능)
    let finalRest;
    if (refundCheck) {
      finalRest = Ct * Ad - Ct * Bd;
    } else {
      finalRest = Ct * Ad;
    }
    // 원화 - 소수점 제거
    finalRestPrice = Math.floor(finalRest);
  } else {
    // 달러 - 소수점 3자리부터 제거 및 반올림
    // 달러 변환 - Bd, Ad 부터 적용
    const Bd1 = Math.round(Bd * 100);
    const Ad1 = Math.round(Ad * 100);
    // 1일 비용 산정
    const Bd2 = Bd1 / Md;
    const Ad2 = Ad1 / Md;
    // 소수점 제거
    const Bd3 = Math.floor(Bd2);
    const Ad3 = Math.floor(Ad2);
    // 기존에 사용내역이 없고 7일이내면 환불가능 (기존 부가서비스의 미사용 일할 계산 가능)
    let finalRest;
    if (refundCheck) {
      finalRest = Ct * Ad3 - Ct * Bd3;
    } else {
      finalRest = Ct * Ad3;
    }
    finalRestPrice = Math.floor(finalRest) * 0.01;
  }

  if (funcResult.optionalServiceResult) {
    // 1. 플랜이 동일하고 부가서비스만 신청하는 경우
    funcResult.restRegularPriceOfPlan = 0; // 플랜 기본 금액

    // 기존에 사용내역이 없고 7일이내면 환불가능 (기존 부가서비스의 미사용 일할 계산 가능)
    if (refundCheck) {
      funcResult.remainingMonths = await oldPlanRemainMonth(subscriptionEnd);
      funcResult.remainingDays = Ct;
      funcResult.discountPrice = finalRestPrice - reqPlanInfo.snsUploadPrice;
      funcResult.discountInfos.push({
        promotionName: 'REMAINDER',
        discountPrice: finalRestPrice - reqPlanInfo.snsUploadPrice,
      });
      // funcResult.discountType = 0; // 전처리
    }
    // funcResult.resultPrice = finalRestPrice;
    funcResult.snsUploadCal = finalRestPrice;
    funcResult.snsUploadOnly = 1; // 부가서비스(업로드)만 결제하는 경우 1
  } else {
    // 2. 일반 케이스의 경우
    funcResult.snsUploadCal = finalRestPrice;
  }

  return funcResult;
}
// * 월 -> 년 부가서비스 계산
async function optionalMonthToYearCal(
  reqPlanInfo,
  funcResult,
  Bc,
  refundCheck,
) {
  // 월 -> 년 - (결제일 기준 새로 년 기간 시작) 기존 월 부가서비스의 남은 기간, 신규 년 플랜의 12개월 기준

  // Bc : 기존 년 부가서비스의 금액 1달 기준 (이전 단계에서 처리해서 전달 받음)
  // Ac : 변경 년 부가서비스의 금액 12달 기준
  // Md : 해당 월의 총 일수 (기존 플랜 기간 기준)
  // Ct : 기존 월 부가서비스의 미사용 일수

  const Ac = funcResult.snsUploadPrice;

  const Md = await subscriptionTotalDays(
    funcResult.userInfo.payment.period,
    funcResult.userInfo.payment.subscriptionExpire,
  );
  const Ct = await subscriptionUnuseDays(
    funcResult.userInfo.payment.subscriptionExpire,
  );

  let finalRestPrice;
  if (funcResult.countryCode === 'KR') {
    // 기존에 사용내역이 없고 7일이내면 환불가능 (기존 부가서비스의 미사용 일할 계산 가능)
    let finalRest;
    if (refundCheck) {
      finalRest = Ac - (Ct / Md) * Bc;
    } else {
      finalRest = Ac;
    }
    // 원화 - 소수점 제거 및 1단위 반올림
    finalRestPrice = Math.floor(finalRest);
  } else {
    // 달러 - 소수점 3자리부터 제거 및 반올림
    // 달러 변환
    const Bc1 = Math.round(Bc * 100);
    const Ac1 = Math.round(Ac * 100);
    // 기존에 사용내역이 없고 7일이내면 환불가능 (기존 부가서비스의 미사용 일할 계산 가능)
    let finalRest;
    if (refundCheck) {
      finalRest = Ac1 - (Ct / Md) * Bc1;
    } else {
      finalRest = Ac1;
    }
    finalRestPrice = Math.floor(finalRest) * 0.01;
  }

  // 월 -> 년 부가서비스 케이스는 일반 케이스만 존재
  funcResult.snsUploadCal = finalRestPrice;

  return funcResult;
}
// * 년 -> 월 부가서비스 계산
async function optionalDowngradeCal(reqPlanInfo, funcResult, Bc, refundCheck) {
  // 다운그레이드 경우로 그냥 처리
  // Ac : 변경 년 부가서비스의 금액 1달 기준

  const Ac = funcResult.snsUploadPrice;

  // 월 -> 년 부가서비스 케이스는 일반 케이스만 존재
  funcResult.snsUploadCal = Ac;

  return funcResult;
}

// 이전 플랜 기준 남은 개월 수
async function oldPlanRemainMonth(subscriptionExpire) {
  const now = moment();
  // 특정 날짜 설정
  const specificDate = moment(subscriptionExpire);
  // 남은 개월 수 계산
  const result = specificDate.diff(now, 'months');
  return result;
}

// 5. 쿠폰 계산 시작
async function couponCal(funcResult, couponId) {
  // const couponInfo = await CouponsV2.findById(couponId);
  const couponInfo = await Coupon.findById(couponId);
  if (!couponInfo) throw 'COUPON INFO NOT FOUND';
  if (couponInfo.planType !== funcResult.planType)
    throw 'COUPON PLANTYPE REQUEST PLANTYPE NOT MATCHED';

  let resultSalePrice = 0;
  // let resultPrice = 0;
  if (couponInfo.type === 'percent') {
    // 할인율 최종 금액 : (최종 결제 금액 + 부가서비스 금액)의 할인율 적용
    resultSalePrice =
      (funcResult.resultPrice + funcResult.snsUploadCal) *
      (couponInfo.value * 0.01);
  } else {
    // 할인금액
    resultSalePrice = couponInfo.value;
  }

  funcResult.couponType = couponInfo.type; // 할인 방식 - percentage : %할인, money : 금액
  funcResult.couponSalePrice = resultSalePrice; // 할인 금액

  return funcResult;
}

// 6. 최종계산
async function finalCal(funcResult) {
  // 최종계산 : 최종금액 + 부가서비스 일할 계산 - 쿠폰 적용 할인 금액
  // 원화는 10원 단위로 처리하고 소수점 제거
  // 달러는 센트를 달러로 변환하고 다시 * 0.01 한후 소수점 2자리까지 표시
  let resultPrice;
  if (funcResult.countryCode === 'KR') {
    const cal =
      funcResult.resultPrice +
      funcResult.snsUploadCal -
      funcResult.couponSalePrice;
    resultPrice = await formatCurrencyKR(cal);
    console.log(
      'finalCal() > formatCurrencyKR() > resultPrice + snsUploadCal - couponSalePrice =',
    );
    console.log(
      'finalCal() > formatCurrencyKR() >',
      funcResult.resultPrice,
      '+',
      funcResult.snsUploadCal,
      '-',
      funcResult.couponSalePrice,
      '=',
      funcResult.resultPrice +
        funcResult.snsUploadCal -
        funcResult.couponSalePrice,
    );
    console.log('finalCal() > formatCurrencyKR() > resultPrice =', resultPrice);
  } else {
    resultPrice = await formatCurrencyUS(
      funcResult.resultPrice,
      funcResult.snsUploadCal,
      funcResult.couponSalePrice,
    );
    console.log(
      'finalCal() > formatCurrencyUS() > resultPrice + snsUploadCal - couponSalePrice =',
    );
    console.log(
      'finalCal() > formatCurrencyUS() >',
      funcResult.resultPrice,
      '+',
      funcResult.snsUploadCal,
      '-',
      funcResult.couponSalePrice,
      '=',
      funcResult.resultPrice +
        funcResult.snsUploadCal -
        funcResult.couponSalePrice,
    );
    console.log('finalCal() > formatCurrencyUS() > resultPrice =', resultPrice);
  }

  // 비용 검증용 sns 업로드, 쿠폰 적용이전의 비용도 저장해봄
  funcResult.resultPrice_sns_coupon = funcResult.resultPrice;

  funcResult.resultPrice = Number(resultPrice);

  return funcResult;
}
// 원화 처리
async function formatCurrencyKR(value) {
  try {
    // 입력값이 숫자인지 확인
    if (isNaN(value)) throw 'PRICE NOT NUMBER';

    // 입력값이 10원 단위 이하인지 확인
    if (value < 10) throw 'PRICE 10 UNDER';

    // 원화를 10원 단위로 처리하고 소수점 제거
    let formatted = Math.floor(value / 10) * 10;
    return formatted;
  } catch (error) {
    console.error(error);
  }
}
// 달러 처리
async function formatCurrencyUS(
  resultPrice,
  snsUploadPrice,
  couponResultPrice,
) {
  try {
    // 입력값이 숫자인지 확인
    if (isNaN(resultPrice) || isNaN(snsUploadPrice) || isNaN(couponResultPrice))
      throw 'PRICE NOT NUMBER';

    // 센트 변환
    const resultPrice1 = Math.round(resultPrice * 100);
    const snsUploadPrice1 = Math.round(snsUploadPrice * 100);
    const couponResultPrice1 = Math.round(couponResultPrice * 100);

    const result = resultPrice1 + snsUploadPrice1 - couponResultPrice1;

    // 달러 변환
    const response = result * 0.01;

    return response.toFixed(2);
  } catch (error) {
    console.error(error);
  }
}

//유저가 보유한 전체 쿠폰 리스트 출력
exports.user_coupon_box = async (req, res) => {
  try {
    // 로그인 필수 아님
    const { userId } = req.userData;

    // 사용자 유효성 확인
    const user = await User.findById(userId);
    // console.log('user =', user);
    if (!user) throw 'USER NOT FOUND';

    const { planType } = req.query;

    const query = {
      userId: userId,
      status: true,
    };
    const couponBox = await CouponBox.find(query).populate('coupon');

    const couponList1 = couponBox.map((item) => {
      return {
        couponId: item.coupon._id,
        title: item.coupon.title,
        subtitle: item.coupon.subtitle,
        planType: item.coupon.planType,
        type: item.coupon.type,
        value: item.coupon.value,
        expired: item.coupon.expired,
      };
    });

    const couponList = couponList1.filter((item) => {
      if (planType) {
        return item.planType === Number(planType);
      } else {
        return item;
      }
    });

    return res.json({
      code: 'SUCCESS',
      data: couponList,
    });
  } catch (error) {
    return res.json({
      code: 'COUPON_ERROR',
      msg: error,
    });
  }
};

// 결제하기 버튼 클릭
exports.payplePayment = async (req, res) => {
  const session = await db.startSession();
  session.startTransaction();
  try {
    const { country, lang } = req.query;
    const { snsUpload, couponId, planType, price, priceCoupon, isContract } =
      req.body;
    const { userId } = req.userData;

    // let method = 'card';

    if (
      !userId ||
      !country ||
      !price ||
      isNaN(planType) ||
      snsUpload === 'undefined' ||
      snsUpload === null ||
      typeof snsUpload !== 'boolean'
    )
      throw { msg: 'BAD_REQUEST' };

    const languageCode = lang == 'ko' ? 'ko' : 'en';
    const countryCode = country == 'KR' ? 'KR' : 'US';

    const userAgent = req.headers['user-agent'];
    const device = deviceChecker(userAgent);

    const user = await User.findById(userId);
    if (!user) throw { msg: 'USER_NOT_FOUND' };

    // 가격 검증 로직 필요 & payment DB 수정 필요
    // 결제하기 상세정보 처리 및 가격검증 처리 공통 함수
    const funcResult = await planDetailPriceVerify(
      userId,
      country,
      snsUpload,
      planType,
      couponId,
      isContract == 'true' || isContract == true,
    );

    if (!funcResult) throw 'ERROR IN PRICE_INFORMATION';

    // 쿠폰 적용 금액 매칭 확인 - 우선 로그만 출력함
    // if (funcResult.couponResultPrice != priceCoupon) throw 'NOT MATCHED PRICE WITH COUPON';
    if (couponId && priceCoupon) {
      if (funcResult.resultPrice != priceCoupon) {
        console.log('payplePayment() > 쿠폰적용 금액 일치하지 않음!');
        console.log(
          'payplePayment() > funcResult.resultPrice =',
          funcResult.resultPrice,
        );
        console.log('payplePayment() > priceCoupon =', priceCoupon);
      } else {
        console.log('payplePayment() > 쿠폰적용 금액 일치!');
      }
    } else {
      console.log('payplePayment() > 쿠폰적용 금액이 존재하지 않음!');

      // 쿠폰이 적용되지 않은 경우 프론트 최종금액 비교
      if (funcResult.resultPrice != price) throw 'PRICE_NOT_MATCHED';
    }

    const reqModifyPayment = funcResult.reqModifyPayment;

    if (price <= 0) throw 'INVALID_ZERO_PRICE_WITHOUT_COUPON';
    // 쿠폰 적용시 0 보다 작으면 에러
    if (couponId && priceCoupon && priceCoupon <= 0)
      throw 'INVALID_ZERO_PRICE_WITH_COUPON';

    // snsUpload 정보 처리 - 결제안함 0, 결제함 1
    let snsUploadNum = 0;
    if (snsUpload) snsUploadNum = 1;

    if (countryCode == 'KR' || !countryCode) {
      currency = 'KRW';
    } else {
      currency = 'USD';
    }

    const invoice = new Invoice({
      userId: userId,
      planType: planType,
      coupon: couponId ? couponId : null,
      promotion: funcResult.ref ? funcResult.ref : null,
      price: funcResult.resultPrice,
      regularPrice: funcResult.restRegularPriceOfPlan,
      reqModifyPayment: reqModifyPayment,
      monthlyScenarioGen: funcResult.monthlyScenarioGen,
      method: 'card',
      period: funcResult.period,
      detail: funcResult.planName, //상세정보 - 건당 결제, 베이직, 스탠다드, 프로 등
      languageCode: languageCode,
      countryCode: countryCode,
      snsUpload: snsUploadNum, // snsUpload 추가 - 결제안함 0, 결제함 1
      snsUploadOnly: funcResult.snsUploadOnly, // 부가서비스(업로드)만 결제하는 경우 1
      snsUploadPrice: funcResult.snsUploadPrice, // snsUpload 기본 비용

      planOriginPrice: funcResult.planOriginPrice, // snsUpload 플랜 기본 비용 처리용

      currency: currency,
    });
    const preparedInvoice = await invoice.save();

    if (!preparedInvoice) throw 'INVOICE_CREATE_ERROR';

    // reqModifyPayment - 변경없음 0, 업그레이드 1, 다운그레이드 -1
    if (reqModifyPayment == -1) {
      // 다운그레이드의 경우
      user.payment.downgradeId = invoice._id;
      if (!user.payment.subscriptionNext)
        user.payment.subscriptionNext = user.payment.subscriptionExpire;
      if (
        countryCode == 'KR' &&
        user.ref &&
        user.ref.status == 0 &&
        (user.ref.domain == 'naver' ||
          user.ref.domain == 'colosseum' ||
          user.ref.domain == 'makeshop' ||
          user.ref.domain == 'godomall')
      ) {
        user.ref.status = 1;
      }
      await user.save();
      return res.json({
        code: 'SUCCESS',
        redirectUrl: `done/${preparedInvoice._id}`,
      });
    } else if (reqModifyPayment == 1) {
      console.log(
        `payplePayment() > ${userId} requested to upgrade the payment plan.`,
      );
    }

    let paypleRespose;
    // 단건과 정기 결제 방식이 동일함
    if (countryCode == 'KR') {
      paypleRespose = await PaypleRest.Payment_KO(
        user,
        device,
        preparedInvoice,
      );
    } else {
      paypleRespose = await PaypleRest.Payment_GLOBAL(
        user,
        device,
        preparedInvoice,
      );
    }

    if (paypleRespose && paypleRespose.isSuccess) {
      return res.json({
        code: 'SUCCESS',
        data: paypleRespose.PAYPLE_REQ_OBJ,
      });
    } else {
      throw 'PAYPLE_PAYMENT_ERROR';
    }
  } catch (error) {
    console.log(error);
    await session.abortTransaction();
    return res.json({
      code: 'FAIL',
    });
  } finally {
    session.endSession();
  }
};

// 한국 PC 결제시 프론트의 콜백 데이터 전달받는 API
exports.payplePaymentResult = async (req, res) => {
  const session = await db.startSession();
  session.startTransaction();
  const { invoiceId } = req.params;
  try {
    if (!invoiceId) throw { msg: 'INVOICE_ID_NOT_FOUND' };

    const paypleResult = req.body;
    if (
      !paypleResult ||
      !paypleResult.PCD_PAY_OID ||
      !paypleResult.PCD_PAY_TOTAL
    )
      throw 'PAYPLE_PAYMENT_RESULT_INVALID';

    // const invoice = await InvoiceV2.findById(invoiceId);
    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) throw { msg: 'INVOICE_NOT_FOUND' };

    const user = await User.findById(invoice.userId);
    if (!user) throw { msg: 'USER_NOT_FOUND' };

    if (
      invoiceId != paypleResult.PCD_PAY_OID ||
      invoice.price != paypleResult.PCD_PAY_TOTAL
    )
      throw 'INVALID_PAYPLE_DATA';

    const paypleRespose = await PaypleRest.CERT(paypleResult);
    if (!paypleRespose || !paypleRespose.isSuccess)
      throw 'PAYPLE_PAYMENT_FAILED';

    // payple 에러시 코드 전달
    if (paypleRespose.paypleCode) throw paypleRespose.paypleCode;

    if (invoice.planType > 0) {
      if (
        invoice.countryCode == 'KR' &&
        user.ref &&
        (user.ref.domain == 'naver' ||
          user.ref.domain == 'colosseum' ||
          user.ref.domain == 'makeshop' ||
          user.ref.domain == 'godomall') &&
        user.ref.status == 0 &&
        user.externals &&
        (user.externals.naver ||
          user.externals.colosseum ||
          user.externals.makeshop ||
          user.externals.godomall) &&
        invoice.planType == 1
      ) {
        user.ref.status = 1;
        invoice.promotion = user.ref.domain;
      }
      // 네이버 프로모션으로 베이직 사용중 업그레이드시 이후 프로모션 혜택 사라짐
      if (invoice.reqModifyPayment == 1) {
        user.ref.status = 2;
      }
      user.payment.paypleBillingKey = paypleRespose.result.PCD_PAYER_ID;
      user.payment.subscription = 1;
      user.payment.paymentType = 'payple';

      if (
        basicMonthlyPlanType.includes(invoice.planType) ||
        basicYearlyPlanType.includes(invoice.planType)
      )
        user.payment.planType = 1;
      else if (
        enterpriseMonthlyPlanType.includes(invoice.planType) ||
        enterpriseYearlyPlanType.includes(invoice.planType)
      )
        user.payment.planType = 3;

      if (
        basicMonthlyPlanType.includes(invoice.planType) ||
        enterpriseMonthlyPlanType.includes(invoice.planType)
      ) {
        // 월간 결제
        user.payment.period = 1;
        user.payment.detail = invoice.detail;
      } else if (
        basicYearlyPlanType.includes(invoice.planType) ||
        enterpriseYearlyPlanType.includes(invoice.planType)
      ) {
        // 연간 결제
        user.payment.period = 2;
        user.payment.detail = invoice.detail;
      } else {
        throw `undefined plan type : ${invoice.planType}`;
      }

      const startDate = new Date();
      const nextPaymentDate = getNextPaymentDate(
        startDate,
        user.payment.period,
      );

      if (
        invoice.reqModifyPayment == 0 &&
        invoice.snsUploadOnly == 1 &&
        invoice.snsUpload == 1
      ) {
        user.payment.snsUpload = 1;
        // 업로드 기간 업데이트
        user.payment.uploadExpire = user.payment.subscriptionExpire;
      } else if (invoice.reqModifyPayment != 1) {
        user.payment.method = invoice.method;
        user.payment.subscriptionStart = startDate;
        user.payment.subscriptionExpire = nextPaymentDate;
        user.payment.subscriptionNext = nextPaymentDate;
        // sns업로드 처리
        if (invoice.snsUpload == 1) {
          user.payment.snsUpload = 1;
          user.payment.uploadExpire = nextPaymentDate;
        }
      } else {
        user.payment.subscriptionNext = user.payment.subscriptionExpire;
        if (invoice.period == 2) {
          // let lastInvoice = await InvoiceV2.findById(user.payment.invoiceId);
          let lastInvoice = await Invoice.findById(user.payment.invoiceId);
          if (!lastInvoice) {
            const invoices = await Invoice.find({
              $and: [{ userId: user._id }, { status: 1 }],
            })
              .sort({ createdAt: -1 })
              .limit(1);
            if (invoices.length > 0) lastInvoice = invoices[0];
          }

          if (lastInvoice) {
            if (lastInvoice.period == 1) {
              const startDate = moment(
                user.payment.subscriptionExpire,
              ).subtract(1, 'months');
              user.payment.subscriptionNext = new Date(
                startDate.add(1, 'years'),
              );
            }
          } else {
            utils.sendMessage(
              `[ERROR] ${user.userName}(${user._id}) 님의 ${invoice.detail} 상품 연간 결제 확인필요.`,
            );
          }
        }
      }

      if (
        invoice.promotion &&
        invoice.promotion != '' &&
        invoice.promotion.includes('_contract')
      ) {
        const contract = await Contract.findById(
          invoice.promotion.replace('_contract', ''),
        );
        if (contract && contract.status == 0) {
          contract.status = 1;
          await contract.save();
        }
      }

      user.payment.invoiceId = invoice._id;
      user.payment.monthlyScenarioGen = invoice.monthlyScenarioGen;
      if (invoice.reqModifyPayment == 0) user.usedScenarioGen = 0;
      // <!--결제 스케쥴 관리를 위한 subscriptions Collection 데이터 생성 Danny
      const subscription = new Subscription({
        userId: user._id,
        planType: invoice.planType,
        subscriptionStatus: 1,
        subscriptionDetail: invoice.detail,
        subscriptionStart: new Date(),
        subscriptionNext: nextPaymentDate,
        repeatPurchase: 0,
        invoiceId: invoiceId,
        billingKey: paypleRespose.result.PCD_PAYER_ID,
      });
      await subscription.save();

      const resultUser = await user.save();

      utils.invoice_log({
        title: 'invoice_approve before subscribeBillingReserve user info',
        userId: user._id,
        msg: user,
      });

      const jobList = schedule.scheduledJobs;
      let isScheduled = false;
      for (const [key, value] of Object.entries(jobList)) {
        if (resultUser._id == key) {
          isScheduled = true;
          break;
        }
      }
      if (isScheduled) jobList[resultUser._id].cancel();

      // subscriptionNext 가 없는 경우 uploadExpire 로 대체
      let subscriptionNext = resultUser.payment.subscriptionNext;
      if (!resultUser.payment.subscriptionNext)
        subscriptionNext = resultUser.payment.uploadExpire;

      schedule.scheduleJob(resultUser._id, subscriptionNext, async function () {
        let user = await User.findById(resultUser._id).select(
          '+payment.paypleBillingKey',
        );

        if (process.env.NODE_ENV == 'production')
          user = await payple_subscribeBilling(user);
        user.markModified(user.payment);
        user.save().then((savedDoc) => {
          console.log(`${savedDoc._id} 다음 결제일 등록`);
        });
        //다음 예약 시간 설정
        job[index].reschedule(moment(user.payment.subscriptionNext).format());
      });
    } else {
      const subtemplate = await Subtemplate.findById(invoice.subtemplate);
      if (!subtemplate) {
        throw {
          code: 'SUBTEMPLATE_NOT_FOUND',
          message: 'SUBTEMPLATE_NOT_FOUND',
        };
      }
      subtemplate.invoiceId = invoiceId;
      await subtemplate.save();

      utils.invoice_log({
        title: 'invoice_approve saved invoice info',
        userId: user._id,
        msg: subtemplate,
      });
      invoice.design = subtemplate.design;
      invoice.subtemplate = subtemplate._id;
    }

    invoice.paypleVerifyResult = paypleRespose.result;
    invoice.status = 1;

    // sns업로드 개발기용 플랜기본 금액 처리
    if (
      invoice.reqModifyPayment == 0 &&
      invoice.snsUploadOnly == 1 &&
      invoice.snsUpload == 1
    ) {
      // 동일플랜에 sns업로드만 추가 경우
      invoice.regularPrice = invoice.planOriginPrice;
    }

    const updateUserData = await user.save();

    const invoiceData = await invoice.save();

    let periodStr = '월간';
    if (user.payment.period == 2) periodStr = '연간';

    let snsUploadStr;
    if (invoiceData.snsUpload == 1) {
      snsUploadStr = 'SNS 업로드 포함';
    } else {
      snsUploadStr = 'SNS 업로드 미포함';
    }

    let webhookPrice;
    if (invoiceData.currency == 'KRW') {
      webhookPrice = invoiceData.price.toLocaleString() + '원';
    } else {
      webhookPrice = '$' + invoiceData.price.toLocaleString();
    }

    utils.sendMessage(
      `${user.userName} \n${invoiceData.detail} - 시나리오 ${user.payment.monthlyScenarioGen}회 \n${snsUploadStr} \n결제금액: ${webhookPrice}`,
    );

    let isMailed = await mailing.sendEmail(user, invoiceData);
    if (isMailed) console.log('MAILING_SUCCESS');
    else console.log('MAILING_FAIL');

    let temTitle = '';
    if (invoiceData.planType == 0 && invoiceData.subtemplate) {
      const subtemplate = await Subtemplate.findById(invoiceData.subtemplate);
      const design = await Design.findById(subtemplate.design);
      temTitle = design.temTitle;
    }

    const payUser = await User.findById(invoiceData.userId);

    return res.json({
      code: 'SUCCESS',
      redirectUrl: `done/${invoice._id}`,
    });
  } catch (error) {
    await session.abortTransaction();
    // const invoice = await InvoiceV2.findById(invoiceId);
    const invoice = await Invoice.findById(invoiceId);
    if (invoice) {
      invoice.paypleErrCode = error;
      invoice.status = -1;
      await invoice.save();
    }
    return res.json({
      code: 'FAIL',
      redirectUrl: `done/${invoice._id}`,
    });
  } finally {
    session.endSession();
  }
};
// 한국 Mobile 결제시 POST Redirect 데이터를 받는 API
exports.payplePaymentResult_Mobile = async (req, res) => {
  const session = await db.startSession();
  session.startTransaction();
  const { invoiceId } = req.params;
  try {
    if (!invoiceId) throw { msg: 'INVOICE_ID_NOT_FOUND' };

    const paypleResult = req.body;
    if (
      !invoiceId ||
      !paypleResult ||
      !paypleResult.PCD_PAY_OID ||
      !paypleResult.PCD_PAY_TOTAL
    )
      throw 'PAYPLE_PAYMENT_RESULT_INVALID';

    // const invoice = await InvoiceV2.findById(invoiceId);
    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) throw 'INVOICE_NOT_FOUND';

    const user = await User.findById(invoice.userId);
    if (!user) throw { msg: 'USER_NOT_FOUND' };

    if (
      invoiceId != paypleResult.PCD_PAY_OID ||
      invoice.price != paypleResult.PCD_PAY_TOTAL
    )
      throw 'INVALID_PAYPLE_DATA';

    const paypleRespose = await PaypleRest.CERT(paypleResult);
    if (!paypleRespose || !paypleRespose.isSuccess)
      throw 'PAYPLE_PAYMENT_FAILED';

    // payple 에러시 코드 전달
    if (paypleRespose.paypleCode) throw paypleRespose.paypleCode;

    if (invoice.planType > 0) {

      // 네이버 프로모션 사용시 상태처리
      if (
        invoice.countryCode == 'KR' &&
        user.ref &&
        (user.ref.domain == 'naver' ||
          user.ref.domain == 'colosseum' ||
          user.ref.domain == 'makeshop' ||
          user.ref.domain == 'godomall') &&
        user.ref.status == 0 &&
        user.externals &&
        (user.externals.naver ||
          user.externals.colosseum ||
          user.externals.makeshop ||
          user.externals.godomall) &&
        invoice.planType == 1
      ) {
        user.ref.status = 1;
        invoice.promotion = user.ref.domain;
      }
      // 네이버 프로모션으로 베이직 사용중 업그레이드시 이후 프로모션 혜택 사라짐
      if (invoice.reqModifyPayment == 1) {
        user.ref.status = 2;
      }
      user.payment.paypleBillingKey = paypleRespose.result.PCD_PAYER_ID;
      user.payment.subscription = 1;
      user.payment.paymentType = 'payple';

      if (
        basicMonthlyPlanType.includes(invoice.planType) ||
        basicYearlyPlanType.includes(invoice.planType)
      )
        user.payment.planType = 1;
      else if (
        enterpriseMonthlyPlanType.includes(invoice.planType) ||
        enterpriseYearlyPlanType.includes(invoice.planType)
      )
        user.payment.planType = 3;

      if (
        basicMonthlyPlanType.includes(invoice.planType) ||
        enterpriseMonthlyPlanType.includes(invoice.planType)
      ) {
        // 월간 결제
        user.payment.period = 1;
        user.payment.detail = invoice.detail;
      } else if (
        basicYearlyPlanType.includes(invoice.planType) ||
        enterpriseYearlyPlanType.includes(invoice.planType)
      ) {
        // 연간 결제
        user.payment.period = 2;
        user.payment.detail = invoice.detail;
      } else {
        throw `undefined plan type : ${invoice.planType}`;
      }

      const startDate = new Date();
      const nextPaymentDate = getNextPaymentDate(
        startDate,
        user.payment.period,
      );

      if (
        invoice.reqModifyPayment == 0 &&
        invoice.snsUploadOnly == 1 &&
        invoice.snsUpload == 1
      ) {
        user.payment.snsUpload = 1;
        // 업로드 기간 업데이트
        user.payment.uploadExpire = user.payment.subscriptionExpire;
      } else if (invoice.reqModifyPayment != 1) {
        user.payment.method = invoice.method;
        user.payment.subscriptionStart = startDate;
        user.payment.subscriptionExpire = nextPaymentDate;
        user.payment.subscriptionNext = nextPaymentDate;
        // sns업로드 처리
        if (invoice.snsUpload == 1) {
          user.payment.snsUpload = 1;
          user.payment.uploadExpire = nextPaymentDate;
        }
      } else {
        console.log('payplePaymentResult() > 기간 변동이 필요없는 경우');
        user.payment.subscriptionNext = user.payment.subscriptionExpire;
        if (invoice.period == 2) {
          // let lastInvoice = await InvoiceV2.findById(user.payment.invoiceId);
          let lastInvoice = await Invoice.findById(user.payment.invoiceId);
          if (!lastInvoice) {
            const invoices = await Invoice.find({
              $and: [{ userId: user._id }, { status: 1 }],
            })
              .sort({ createdAt: -1 })
              .limit(1);
            if (invoices.length > 0) lastInvoice = invoices[0];
          }

          if (lastInvoice) {
            if (lastInvoice.period == 1) {
              const startDate = moment(
                user.payment.subscriptionExpire,
              ).subtract(1, 'months');
              user.payment.subscriptionNext = new Date(
                startDate.add(1, 'years'),
              );
            }
          } else {
            utils.sendMessage(
              `[ERROR] ${user.userName}(${user._id}) 님의 ${invoice.detail} 상품 연간 결제 확인필요.`,
            );
          }
        }
      }

      if (
        invoice.promotion &&
        invoice.promotion != '' &&
        invoice.promotion.includes('_contract')
      ) {
        const contract = await Contract.findById(
          invoice.promotion.replace('_contract', ''),
        );
        if (contract && contract.status == 0) {
          contract.status = 1;
          await contract.save();
        }
      }

      user.payment.invoiceId = invoice._id;
      user.payment.monthlyScenarioGen = invoice.monthlyScenarioGen;
      if (invoice.reqModifyPayment == 0) user.usedScenarioGen = 0;
      // <!--결제 스케쥴 관리를 위한 subscriptions Collection 데이터 생성 Danny
      const subscription = new Subscription({
        userId: user._id,
        planType: invoice.planType,
        subscriptionStatus: 1,
        subscriptionDetail: invoice.detail,
        subscriptionStart: new Date(),
        subscriptionNext: nextPaymentDate,
        repeatPurchase: 0,
        invoiceId: invoiceId,
        billingKey: paypleRespose.result.PCD_PAYER_ID,
      });
      await subscription.save();

      const resultUser = await user.save();
      utils.invoice_log({
        title: 'invoice_approve before subscribeBillingReserve user info',
        userId: user._id,
        msg: user,
      });

      const jobList = schedule.scheduledJobs;
      let isScheduled = false;
      for (const [key, value] of Object.entries(jobList)) {
        if (resultUser._id == key) {
          isScheduled = true;
          break;
        }
      }
      if (isScheduled) jobList[resultUser._id].cancel();

      // subscriptionNext 가 없는 경우 uploadExpire 로 대체
      let subscriptionNext = resultUser.payment.subscriptionNext;
      if (!resultUser.payment.subscriptionNext)
        subscriptionNext = resultUser.payment.uploadExpire;

      schedule.scheduleJob(resultUser._id, subscriptionNext, async function () {
        let user = await User.findById(resultUser._id).select(
          '+payment.paypleBillingKey',
        );

        if (process.env.NODE_ENV == 'production')
          user = await payple_subscribeBilling(user);
        user.markModified(user.payment);
        user.save().then((savedDoc) => {
          console.log(`${savedDoc._id} 다음 결제일 등록`);
        });
        //다음 예약 시간 설정
        job[index].reschedule(moment(user.payment.subscriptionNext).format());
      });
    } else {
      const subtemplate = await Subtemplate.findById(invoice.subtemplate);
      if (!subtemplate) {
        throw {
          code: 'SUBTEMPLATE_NOT_FOUND',
          message: 'SUBTEMPLATE_NOT_FOUND',
        };
      }
      subtemplate.invoiceId = invoiceId;
      await subtemplate.save();

      utils.invoice_log({
        title: 'invoice_approve saved invoice info',
        userId: user._id,
        msg: subtemplate,
      });
      invoice.design = subtemplate.design;
      invoice.subtemplate = subtemplate._id;
    }

    invoice.paypleVerifyResult = paypleRespose.result;
    invoice.status = 1;

    // sns업로드 개발기용 플랜기본 금액 처리
    if (
      invoice.reqModifyPayment == 0 &&
      invoice.snsUploadOnly == 1 &&
      invoice.snsUpload == 1
    ) {
      // 동일플랜에 sns업로드만 추가 경우
      invoice.regularPrice = invoice.planOriginPrice;
    }

    console.log('payplePaymentResult_Mobile() > user =', user);
    const updateUserData = await user.save();
    console.log(
      'payplePaymentResult_Mobile() > updateUserData =',
      updateUserData,
    );

    const invoiceData = await invoice.save();

    let periodStr = '월간';
    if (user.payment.period == 2) periodStr = '연간';

    let snsUploadStr;
    if (invoiceData.snsUpload == 1) {
      snsUploadStr = 'SNS 업로드 포함';
    } else {
      snsUploadStr = 'SNS 업로드 미포함';
    }

    let webhookPrice;
    if (invoiceData.currency == 'KRW') {
      webhookPrice = invoiceData.price.toLocaleString() + '원';
    } else {
      webhookPrice = '$' + invoiceData.price.toLocaleString();
    }

    utils.sendMessage(
      `${user.userName} \n${invoiceData.detail} - 시나리오 ${user.payment.monthlyScenarioGen}회 \n${snsUploadStr} \n결제금액: ${webhookPrice}`,
    );
    console.log(
      'payplePaymentResult() > utils.sendMessage() =',
      `${user.userName} \n${invoiceData.detail} - 시나리오 ${user.payment.monthlyScenarioGen}회 \n${snsUploadStr} \n결제금액: ${webhookPrice}`,
    );

    let isMailed = await mailing.sendEmail(user, invoiceData);
    if (isMailed) console.log('MAILING_SUCCESS');
    else console.log('MAILING_FAIL');

    let temTitle = '';
    if (invoiceData.planType == 0 && invoiceData.subtemplate) {
      const subtemplate = await Subtemplate.findById(invoiceData.subtemplate);
      const design = await Design.findById(subtemplate.design);
      temTitle = design.temTitle;
    }

    const payUser = await User.findById(invoiceData.userId);

    let redirectUrl;
    if (invoice.planType == 0) {
      redirectUrl = `${SINGLE_PAYMENT_DONE_URL}${invoice._id}`;
    } else {
      if (
        invoice.promotion &&
        invoice.promotion != '' &&
        invoice.promotion.includes('_contract')
      ) {
        redirectUrl = CONTRACT_PAYMENT_DONE_URL;
      } else {
        redirectUrl = `${SUBSCRIPTION_PAYMENT_DONE_URL}${invoice._id}`;
      }
    }
    return res.redirect(redirectUrl); // 실제 프론트 결제 완료 페이지 URL
  } catch (error) {
    await session.abortTransaction();
    const invoice = await Invoice.findById(invoiceId);
    if (invoice) {
      invoice.paypleErrCode = error;
      invoice.status = -1;
      await invoice.save();
    }
    return res.redirect(`${SINGLE_PAYMENT_DONE_URL}${invoiceId}`); // 실제 프론트 결제 실패 페이지 URL
  } finally {
    session.endSession();
  }
};
// GLOBAL 결제시 POST Redirect 데이터를 받는 API
exports.payplePaymentResult_GLOBAL = async (req, res) => {
  const session = await db.startSession();
  session.startTransaction();
  const { invoiceId } = req.params;
  try {
    if (!invoiceId) throw { msg: 'INVOICE_ID_NOT_FOUND' };

    const paypleResult = req.body;

    if (!invoiceId || !paypleResult) throw 'PAYPLE_PAYMENT_RESULT_INVALID';
    if (
      paypleResult.result != 'A0000' ||
      !paypleResult ||
      !paypleResult.billing_key
    ) {
      console.log('PAYPLE_MSG : ' + paypleResult.message);
      throw 'PAYPLE_PAYMENT_RESULT_FAILED';
    }

    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) throw 'INVOICE_NOT_FOUND';

    const user = await User.findById(invoice.userId);
    if (!user) throw { msg: 'USER_NOT_FOUND' };

    if (
      invoiceId != paypleResult.service_oid ||
      invoice.price != paypleResult.totalAmount
    )
      throw 'INVALID_PAYPLE_DATA';

    if (invoice.planType > 0) {

      // 네이버 프로모션 사용시 상태처리 없음 -> 해외 유저의 경우 네이버 할인 없음
      if (invoice.countryCode != 'KR' && invoice.planType == 1) {
        invoice.promotion = 'ABROAD PROMOTION';
      }

      user.payment.paypleBillingKey = paypleResult.billing_key;
      user.payment.subscription = 1;
      user.payment.paymentType = 'payple';

      if (
        basicMonthlyPlanType.includes(invoice.planType) ||
        basicYearlyPlanType.includes(invoice.planType)
      )
        user.payment.planType = 1;
      else if (
        enterpriseMonthlyPlanType.includes(invoice.planType) ||
        enterpriseYearlyPlanType.includes(invoice.planType)
      )
        user.payment.planType = 3;

      if (
        basicMonthlyPlanType.includes(invoice.planType) ||
        enterpriseMonthlyPlanType.includes(invoice.planType)
      ) {
        // 월간 결제
        user.payment.period = 1;
        user.payment.detail = invoice.detail;
      } else if (
        basicYearlyPlanType.includes(invoice.planType) ||
        enterpriseYearlyPlanType.includes(invoice.planType)
      ) {
        // 연간 결제
        user.payment.period = 2;
        user.payment.detail = invoice.detail;
      } else {
        throw `undefined plan type : ${invoice.planType}`;
      }

      const startDate = new Date();
      const nextPaymentDate = getNextPaymentDate(
        startDate,
        user.payment.period,
      );

      if (
        invoice.reqModifyPayment == 0 &&
        invoice.snsUploadOnly == 1 &&
        invoice.snsUpload == 1
      ) {
        user.payment.snsUpload = 1;
        // 업로드 기간 업데이트
        user.payment.uploadExpire = user.payment.subscriptionExpire;
      } else if (invoice.reqModifyPayment != 1) {
        user.payment.method = invoice.method;
        user.payment.subscriptionStart = startDate;
        user.payment.subscriptionExpire = nextPaymentDate;
        user.payment.subscriptionNext = nextPaymentDate;
        // sns업로드 처리
        if (invoice.snsUpload == 1) {
          user.payment.snsUpload = 1;
          user.payment.uploadExpire = nextPaymentDate;
        }
      } else {
        user.payment.subscriptionNext = user.payment.subscriptionExpire;
        if (invoice.period == 2) {
          let lastInvoice = await Invoice.findById(user.payment.invoiceId);
          if (!lastInvoice) {
            const invoices = await Invoice.find({
              $and: [{ userId: user._id }, { status: 1 }],
            })
              .sort({ createdAt: -1 })
              .limit(1);
            if (invoices.length > 0) lastInvoice = invoices[0];
          }

          if (lastInvoice) {
            if (lastInvoice.period == 1) {
              const startDate = moment(
                user.payment.subscriptionExpire,
              ).subtract(1, 'months');
              user.payment.subscriptionNext = new Date(
                startDate.add(1, 'years'),
              );
            }
          } else {
            utils.sendMessage(
              `[ERROR] ${user.userName}(${user._id}) 님의 ${invoice.detail} 상품 연간 결제 확인필요.`,
            );
          }
        }
      }

      if (
        invoice.promotion &&
        invoice.promotion != '' &&
        invoice.promotion.includes('_contract')
      ) {
        const contract = await Contract.findById(
          invoice.promotion.replace('_contract', ''),
        );
        if (contract && contract.status == 0) {
          contract.status = 1;
          await contract.save();
        }
      }

      user.payment.invoiceId = invoice._id;
      user.payment.monthlyScenarioGen = invoice.monthlyScenarioGen;
      if (invoice.reqModifyPayment == 0) user.usedScenarioGen = 0;
      // <!--결제 스케쥴 관리를 위한 subscriptions Collection 데이터 생성 Danny
      const subscription = new Subscription({
        userId: user._id,
        planType: invoice.planType,
        subscriptionStatus: 1,
        subscriptionDetail: invoice.detail,
        subscriptionStart: new Date(),
        subscriptionNext: nextPaymentDate,
        repeatPurchase: 0,
        invoiceId: invoiceId,
        billingKey: paypleResult.billing_key,
      });
      await subscription.save();

      const resultUser = await user.save();

      utils.invoice_log({
        title: 'invoice_approve before subscribeBillingReserve user info',
        userId: user._id,
        msg: user,
      });

      const jobList = schedule.scheduledJobs;
      let isScheduled = false;
      for (const [key, value] of Object.entries(jobList)) {
        if (resultUser._id == key) {
          isScheduled = true;
          break;
        }
      }
      if (isScheduled) jobList[resultUser._id].cancel();

      // subscriptionNext 가 없는 경우 uploadExpire 로 대체
      let subscriptionNext = resultUser.payment.subscriptionNext;
      if (!resultUser.payment.subscriptionNext)
        subscriptionNext = resultUser.payment.uploadExpire;

      schedule.scheduleJob(resultUser._id, subscriptionNext, async function () {
        let user = await User.findById(resultUser._id).select(
          '+payment.paypleBillingKey',
        );

        if (process.env.NODE_ENV == 'production')
          user = await payple_subscribeBilling(user);
        user.markModified(user.payment);
        user.save().then((savedDoc) => {
          console.log(`${savedDoc._id} 다음 결제일 등록`);
        });
        //다음 예약 시간 설정
        job[index].reschedule(moment(user.payment.subscriptionNext).format());
      });
    } else {
      const subtemplate = await Subtemplate.findById(invoice.subtemplate);
      if (!subtemplate) {
        throw {
          code: 'SUBTEMPLATE_NOT_FOUND',
          message: 'SUBTEMPLATE_NOT_FOUND',
        };
      }
      subtemplate.invoiceId = invoiceId;
      await subtemplate.save();

      utils.invoice_log({
        title: 'invoice_approve saved invoice info',
        userId: user._id,
        msg: subtemplate,
      });
      invoice.design = subtemplate.design;
      invoice.subtemplate = subtemplate._id;
    }

    invoice.paypleVerifyResult = paypleResult;
    invoice.status = 1;

    // sns업로드 개발기용 플랜기본 금액 처리
    if (
      invoice.reqModifyPayment == 0 &&
      invoice.snsUploadOnly == 1 &&
      invoice.snsUpload == 1
    ) {
      // 동일플랜에 sns업로드만 추가 경우
      invoice.regularPrice = invoice.planOriginPrice;
    }

    const updateUserData = await user.save();

    const invoiceData = await invoice.save();

    let periodStr = '월간';
    if (user.payment.period == 2) periodStr = '연간';

    let snsUploadStr;
    if (invoiceData.snsUpload == 1) {
      snsUploadStr = 'SNS 업로드 포함';
    } else {
      snsUploadStr = 'SNS 업로드 미포함';
    }

    let webhookPrice;
    if (invoiceData.currency == 'KRW') {
      webhookPrice = invoiceData.price.toLocaleString() + '원';
    } else {
      webhookPrice = '$' + invoiceData.price.toLocaleString();
    }

    utils.sendMessage(
      `${user.userName} \n${invoiceData.detail} - 시나리오 ${user.payment.monthlyScenarioGen}회 \n${snsUploadStr} \n결제금액: ${webhookPrice}`,
    );
    console.log(
      'payplePaymentResult() > utils.sendMessage() =',
      `${user.userName} \n${invoiceData.detail} - 시나리오 ${user.payment.monthlyScenarioGen}회 \n${snsUploadStr} \n결제금액: ${webhookPrice}`,
    );

    let isMailed = await mailing.sendEmail(user, invoiceData);
    if (isMailed) console.log('MAILING_SUCCESS');
    else console.log('MAILING_FAIL');

    let temTitle = '';
    if (invoiceData.planType == 0 && invoiceData.subtemplate) {
      const subtemplate = await Subtemplate.findById(invoiceData.subtemplate);
      const design = await Design.findById(subtemplate.design);
      temTitle = design.temTitle;
    }
    let detail = '';
    if (invoiceData.planType == 0) detail = '건당 결제';
    else if (invoiceData.planType == 1) detail = '베이직';
    else if (invoiceData.planType > 2) detail = '스탠다드';

    const payUser = await User.findById(invoiceData.userId);

    let redirectUrl;
    if (invoice.planType == 0) {
      redirectUrl = `${SINGLE_PAYMENT_DONE_URL}${invoice._id}`;
    } else {
      if (
        invoice.promotion &&
        invoice.promotion != '' &&
        invoice.promotion.includes('_contract')
      ) {
        redirectUrl = CONTRACT_PAYMENT_DONE_URL;
      } else {
        redirectUrl = `${SUBSCRIPTION_PAYMENT_DONE_URL}${invoice._id}`;
      }
    }
    return res.redirect(redirectUrl); // 실제 프론트 결제 완료 페이지 URL
  } catch (error) {
    console.log(error);
    await session.abortTransaction();
    const invoice = await Invoice.findById(invoiceId);
    if (invoice) {
      invoice.status = -1;
      await invoice.save();
    }
    return res.redirect(`${SINGLE_PAYMENT_DONE_URL}${invoiceId}`); // 실제 프론트 결제 실패 페이지 URL
  } finally {
    session.endSession();
  }
};
async function payple_subscribeBilling(user) {
  let invoiceId = user.payment.invoiceId;
  let price;
  let modifyStr = '';
  if (!!user.payment.downgradeId && user.payment.downgradeId != null) {
    invoiceId = user.payment.downgradeId;
    modifyStr = '[DOWNGRADED]';
    user.payment.downgradeId = null;
  }

  const invoice = await Invoice.findById(invoiceId);
  const currency = invoice.countryCode == 'KR' ? 'KRW' : 'USD';
  let planType = invoice.planType;
  const newPaymentPlan = await paymentPlan.findOne({
    $and: [
      { languageCode: invoice.languageCode },
      { countryCode: invoice.countryCode },
      {
        $or: [
          { 'plans.monthly.type': planType },
          { 'plans.annually.type': planType },
        ],
      },
    ],
  });
  if (!newPaymentPlan) throw 'PLAN INFO NOT FOUND';

  let newInvoiceDetail = newPaymentPlan.name;
  let newInvoiceRegularPrice = 0;
  let newInvoicePeriod = 0;
  let newInvoiceScenarioGen = 0;

  // snsUpload 추가
  let newSnsUpload = 0;
  let newSnsUploadOnly = 0;
  let newSnsUploadPrice = 0;

  if (
    basicMonthlyPlanType.includes(planType) ||
    enterpriseMonthlyPlanType.includes(planType)
  ) {
    for (let i = 0; i < newPaymentPlan.plans.monthly.length; i++) {
      if (newPaymentPlan.plans.monthly[i].type == planType) {
        newInvoiceRegularPrice = newPaymentPlan.plans.monthly[i].price;
        newInvoicePeriod = 1;
        newInvoiceScenarioGen =
          newPaymentPlan.plans.monthly[i].monthlyScenarioGen;
        break;
      }
    }
  } else if (
    basicYearlyPlanType.includes(planType) ||
    enterpriseYearlyPlanType.includes(planType)
  ) {
    for (let i = 0; i < newPaymentPlan.plans.annually.length; i++) {
      if (newPaymentPlan.plans.annually[i].type == planType) {
        newInvoiceRegularPrice = newPaymentPlan.plans.annually[i].price;
        newInvoicePeriod = 2;
        newInvoiceScenarioGen =
          newPaymentPlan.plans.monthly[i].monthlyScenarioGen;
        break;
      }
    }
  }

  if (
    !!invoice.regularPrice &&
    invoice.regularPrice != 0 &&
    !isNaN(invoice.regularPrice)
  ) {
    price =
      !!user.payment.downgradeId && user.payment.downgradeId != null
        ? invoice.price
        : invoice.regularPrice;
  } else {
    price = newInvoiceRegularPrice;
  }

  if (!!invoice.reqModifyPayment && invoice.reqModifyPayment == 1) {
    price = newInvoiceRegularPrice;
    modifyStr = '[UPGRADED]';
  }

  // 부가서비스만 추가하는 경우 추가
  if (
    invoice.reqModifyPayment == 0 &&
    invoice.snsUploadOnly == 1 &&
    invoice.snsUpload == 1
  ) {
    price = price + invoice.snsUploadPrice;
    newSnsUpload = 1;
    newSnsUploadOnly = 1;
    newSnsUploadPrice = invoice.snsUploadPrice;
  }
  // 일반요금제에 부가서비스도 추가
  if (invoice.snsUploadOnly == 0 && invoice.snsUpload == 1) {
    price = price + invoice.snsUploadPrice;
    newSnsUpload = 1;
    newSnsUploadOnly = 0;
    newSnsUploadPrice = invoice.snsUploadPrice;
  }

  let discountPrice = 0;
  let discountInfos = [];

  let isContract = false;
  if (
    invoice.promotion &&
    invoice.promotion != '' &&
    invoice.promotion.includes('_contract')
  ) {
    const contract = await Contract.findOne({
      $and: [
        { _id: invoice.promotion.replace('_contract', '') },
        { status: 1 },
      ],
    });
    if (contract) {
      console.log('CONTRACT EXISTS');
      const bestPromotion = await Promotion.findOne({
        domain: invoice.promotion,
      });
      if (bestPromotion) {
        isContract = true;
        if (bestPromotion.discountType == 0) {
          discountPrice += bestPromotion.discountValue;
          discountInfos.push({
            promotionName: bestPromotion.domain,
            discountPrice: bestPromotion.discountValue,
          });
        } else if (bestPromotion.discountType == 1) {
          discountPrice +=
            priceInfo.price * (bestPromotion.discountValue / 100);
          discountInfos.push({
            promotionName: bestPromotion.domain,
            discountPrice:
              priceInfo.price * (bestPromotion.discountValue / 100),
          });
        }
      }
    } else {
      console.log('CONTRACT NOT FOUND');
    }
  }

  if (
    user.ref &&
    user.ref.status == 1 &&
    user.ref.domain &&
    user.ref.domain != '' &&
    !isContract
  ) {
    const promotions = await Promotion.find({
      $and: [
        { domain: user.ref.domain },
        { planType: planType },
        { currency: currency },
        { startDate: { $lte: new Date() } },
      ],
    });
    let bestPromotion;
    if (promotions && promotions.length > 0) {
      for (let promo of promotions) {
        if (!bestPromotion) bestPromotion = promo;
        else {
          if (bestPromotion.discountType == 0) {
            if (promo.discountType == 0) {
              if (promo.discountValue > bestPromotion.discountValue)
                bestPromotion = promo;
            } else if (promo.discountType == 1) {
              let calcPrice = priceInfo.price * (promo.discountValue / 100);
              if (calcPrice > bestPromotion.discountValue)
                bestPromotion = promo;
            }
          } else if (bestPromotion.discountType == 1) {
            if (promo.discountType == 0) {
              let calcPrice =
                priceInfo.price * (bestPromotion.discountValue / 100);
              if (promo.discountValue > calcPrice) bestPromotion = promo;
            } else if (promo.discountType == 1) {
              if (promo.discountValue > bestPromotion.discountValue)
                bestPromotion = promo;
            }
          }
        }
      }
    }
    if (bestPromotion) {
      if (bestPromotion.discountType == 0) {
        discountPrice += bestPromotion.discountValue;
        discountInfos.push({
          promotionName: bestPromotion.domain,
          discountPrice: bestPromotion.discountValue,
        });
      } else if (bestPromotion.discountType == 1) {
        discountPrice += priceInfo.price * (bestPromotion.discountValue / 100);
        discountInfos.push({
          promotionName: bestPromotion.domain,
          discountPrice: priceInfo.price * (bestPromotion.discountValue / 100),
        });
      }
    }
  }

  if (planType == 1 && user.countryCode != 'KR' && !isContract) {
    discountPrice = 8.01;
    discountInfos.push({
      promotionName: 'ABROAD PROMOTION',
      discountPrice: 8.01,
    });
  }

  price -= discountPrice;

  // 부가서비스만 해지시
  if (invoice.snsUpload == 0) {
    price = price - invoice.snsUploadPrice;
    // snsUpload 추가
    newSnsUpload = 0;
    newSnsUploadOnly = 0;
    newSnsUploadPrice = 0;
  }

  let billingResult;
  console.log('결제갱신');
  try {
    let reserveCurrency = 'USD';
    if (!invoice.currency) {
      if (invoice.countryCode === 'KR') reserveCurrency = 'KRW';
    }
    const reserveInvoice = new Invoice({
      userId: invoice.userId,
      planType: invoice.planType,
      coupon: null,
      price: price,
      regularPrice: newInvoiceRegularPrice,
      status: 0, // 상태는 결재 이전 상태여야함.
      method: invoice.method,
      period: newInvoicePeriod,
      detail: newInvoiceDetail,
      languageCode: invoice.languageCode,
      countryCode: invoice.countryCode,
      monthlyScenarioGen: newInvoiceScenarioGen,

      // snsUpload 추가
      snsUpload: newSnsUpload,
      snsUploadOnly: newSnsUploadOnly,
      snsUploadPrice: newSnsUploadPrice,

      currency: reserveCurrency,
    });

    if (discountInfos.length > 0) {
      if (invoice.countryCode == 'KR') {
        user.ref.status = 1;
        reserveInvoice.promotion = discountInfos[0].promotionName;
      } else if (invoice.countryCode != 'KR' && invoice.planType == 1) {
        reserveInvoice.promotion = discountInfos[0].promotionName;
      }
    }
    const invoiceData = await reserveInvoice.save();

    // 빌링 성공, 실패 처리
    if (invoice.countryCode == 'KR') {
      billingResult = await PaypleRest.billingPayment_KO(user, invoiceData);
      if (billingResult.isSuccess) {
        user.payment.paypleBillingKey = billingResult.result.PCD_PAYER_ID
          ? billingResult.result.PCD_PAYER_ID
          : user.payment.paypleBillingKey;
        const resultInvoice = await Invoice.findById(invoiceData._id);
        resultInvoice.paypleVerifyResult = billingResult.result;
        resultInvoice.status = 1;
        await resultInvoice.save();
      } else {
        const resultInvoice = await Invoice.findById(invoiceData._id);
        resultInvoice.paypleVerifyResult = billingResult.result;
        await resultInvoice.save();
      }
    } else {
      billingResult = await PaypleRest.billingPayment_GLOBAL(user, invoiceData);
      if (billingResult.isSuccess) {
        user.payment.paypleBillingKey = billingResult.result.billing_key
          ? billingResult.result.billing_key
          : user.payment.paypleBillingKey;
        const resultInvoice = await Invoice.findById(invoiceData._id);
        resultInvoice.paypleVerifyResult = billingResult.result;
        resultInvoice.status = 1;
        await resultInvoice.save();
      } else {
        const resultInvoice = await Invoice.findById(invoiceData._id);
        resultInvoice.paypleVerifyResult = billingResult.result;
        await resultInvoice.save();
      }
    }

    //인보이스 갱신
    user.payment.invoiceId = invoiceData.id;
    //다음 결제일 등록
    const nextPaymentDate = await getNextPaymentDate(
      new Date(user.payment.subscriptionStart),
      newInvoicePeriod,
    );

    let newUserPlanType = 0;
    if (
      basicMonthlyPlanType.includes(invoice.planType) ||
      basicYearlyPlanType.includes(invoice.planType)
    )
      newUserPlanType = 1;
    else if (
      enterpriseMonthlyPlanType.includes(invoice.planType) ||
      enterpriseYearlyPlanType.includes(invoice.planType)
    )
      newUserPlanType = 3;

    user.payment.planType = newUserPlanType;
    user.payment.detail = newInvoiceDetail;
    user.payment.subscriptionNext = nextPaymentDate;
    user.payment.subscriptionExpire = nextPaymentDate;
    user.payment.uploadExpire = nextPaymentDate;
    user.payment.downgradeId = null;
    user.payment.monthlyScenarioGen = newInvoiceScenarioGen;
    user.usedScenarioGen = 0;
    user.payment.snsUpload = newSnsUpload;

    if (billingResult.isSuccess) {
      const validInvoice = await Invoice.findById(invoiceData._id).select(
        '+paypleVerifyResult',
      );
      if (validInvoice.price > 0) {
        let isMailed = await mailing.sendEmail(user, validInvoice);
        if (isMailed) console.log('MAILING_SUCCESS');
        else console.log('MAILING_FAIL');
      }
      let periodStr = '월간';
      if (user.payment.period == 2) periodStr = '연간';

      let snsUploadStr = ' ';
      if (invoice.snsUpload == 1) snsUploadStr = ', SNS 업로드를 포함한 ';

      utils.sendMessage(
        `${modifyStr} ${user.userName}(${user._id}) 님의 ${
          invoice.detail
        } 플랜, 시나리오 ${
          user.payment.monthlyScenarioGen
        }회${snsUploadStr}${periodStr} 구독(${invoiceData.currency} ${
          invoiceData.price
        })이 갱신되었습니다.\n 다음 결제일은 ${moment(
          user.payment.subscriptionNext,
        ).format()}입니다 `,
      );
    } else {
      utils.sendMessage(
        `${modifyStr} ${user.userName}(${user._id})님의 ${invoice.detail}가 갱신되지 못했습니다.\n InvoiceID : ${invoiceData.id} \n `,
      );
      throw invoice.countryCode == 'KR'
        ? billingResult.result.PCD_PAY_MSG
        : billingResult.result.message;
    }

    const resultInvoice = await Invoice.findById(invoiceData._id).select(
      '+paypleVerifyResult',
    );
    let detail = '';
    if (resultInvoice.planType == 0) detail = '건당 결제';
    else if (
      basicMonthlyPlanType.includes(resultInvoice.planType) ||
      basicYearlyPlanType.includes(resultInvoice.planType)
    )
      detail = '베이직';
    else if (
      enterpriseMonthlyPlanType.includes(resultInvoice.planType) ||
      enterpriseYearlyPlanType.includes(resultInvoice.planType)
    )
      detail = '엔터프라이즈';

    const payUser = await User.findById(resultInvoice.userId);

  } catch (error) {
    utils.invoice_log({
      title: 'payple_subscribeBilling ERROR',
      userId: user._id,
      msg:
        invoice.countryCode == 'KR'
          ? billingResult.result.PCD_PAY_MSG
          : billingResult.result.message,
    });
    utils.sendMessage(
      `${user.userName}(${user._id})님의 결제의 오류가 발생 [PAYPLE]로그 확인 요망 `,
    );
    utils.sendMessage(error.toString());
    if ((error.statusCode = 500)) {
      const mms = twilioClient.sendMsg(
        user.userPhoneNumber,
        CONF.cutomer_constant.bootpay_fail_msg,
      );
      console.log('결제 실패 MMS 발송');
      console.log(mms);
    }
    console.error(error);
  }

  return user;
}

// 부가서비스(sns업로드) 해지
exports.optionalCancel = async (req, res) => {
  try {
    const userId = req.userData.userId;
    if (!userId || userId == '') throw 'USER_NOT_FOUND';

    const user = await User.findById(userId);
    if (!user) throw 'USER NOT FOUND';

    // 기존 인보이스를 확인한다
    const invoice = await Invoice.findById(user.payment.invoiceId);

    invoice.snsUpload = 0;
    invoice.snsUploadOnly = 0;
    invoice.snsUploadPrice = 0;

    await invoice.save();

    user.payment.snsUpload = 0;
    await user.save();

    return res.json({
      code: 'SUCCESS',
    });
  } catch (error) {
    console.log(error);
    return res.json({
      code: 'FAIL',
    });
  }
};

async function subscription_scheduler() {
  let jobList = schedule.scheduledJobs;

  for (const [key, value] of Object.entries(jobList)) {
    console.log(`${key}: ${value}`);
    jobList[key].cancel();
    console.log(jobList[key]);
  }

  // 페이플 정기결제자
  const query_payple = {
    $and: [
      { 'payment.subscriptionNext': { $gte: new Date() } },
      { 'payment.paymentType': 'payple' },
    ],
  };
  const users_payple = await User.find(query_payple);

  let jobList2_payple = schedule.scheduledJobs;
  let job_payple = [];

  for (let index = 0; index < users_payple.length; index++) {
    if (jobList2_payple[users_payple[index]._id])
      jobList2_payple[users_payple[index]._id].cancel();

    job_payple[index] = schedule.scheduleJob(
      users_payple[index]._id,
      users_payple[index].payment.subscriptionNext,
      async function () {
        let user = await User.findById(users_payple[index]._id).select(
          '+payment.paypleBillingKey',
        );

        if (user.snsAccount && user.snsAccount.instagram == []) {
          user.snsAccount.instagram = {
            accountInfo: [],
            userSelectAccount: [],
            pageInfo: [],
            userSelectPage: [],
          };
        }

        user = await payple_subscribeBilling(user);

        user.markModified(user.payment);
        user.save().then((savedDoc) => {
          console.log(`${savedDoc._id} 다음 결제일 등록`);
        });

        job_payple[index].reschedule(
          moment(user.payment.subscriptionNext).format(),
        );
      },
    );
  }
  //console.log(job)
}
async function subscription_scheduler_development() {
  let jobList = schedule.scheduledJobs;

  for (const [key, value] of Object.entries(jobList)) {
    console.log(`${key}: ${value}`);
    jobList[key].cancel();
    console.log(jobList[key]);
  }

  // 페이플 정기결제자
  const query_payple = {
    $and: [
      { 'payment.subscriptionNext': { $gte: new Date() } },
      { 'payment.paymentType': 'payple' },
    ],
  };
  const users_payple = await User.find(query_payple);

  let jobList2_payple = schedule.scheduledJobs;
  let job_payple = [];

  for (let index = 0; index < users_payple.length; index++) {
    if (
      users_payple[index]._id == '66136626327ce5635f2ec940' ||
      users_payple[index]._id == '66307c0ea6b0b3197227f676' ||
      users_payple[index]._id == '664e2f4a14e18f3af9cb8080' ||
      users_payple[index]._id == '60f95908941293342f6ae8ba' ||
      users_payple[index]._id == '665465fea77355ba1890c527'
    ) {
      if (jobList2_payple[users_payple[index]._id])
        jobList2_payple[users_payple[index]._id].cancel();

      job_payple[index] = schedule.scheduleJob(
        users_payple[index]._id,
        users_payple[index].payment.subscriptionNext,
        async function () {
          let user = await User.findById(users_payple[index]._id).select(
            '+payment.paypleBillingKey',
          );

          if (user.snsAccount && user.snsAccount.instagram == []) {
            user.snsAccount.instagram = {
              accountInfo: [],
              userSelectAccount: [],
              pageInfo: [],
              userSelectPage: [],
            };
          }

          user = await payple_subscribeBilling(user);

          user.markModified(user.payment);
          user.save().then((savedDoc) => {
            console.log(`${savedDoc._id} 다음 결제일 등록`);
          });

          job_payple[index].reschedule(
            moment(user.payment.subscriptionNext).format(),
          );
        },
      );
    }
  }
}
if (SCHEDULE_EXE) {
  subscription_scheduler();
} else {
  subscription_scheduler_development();
}

async function subscription_mail_scheduler() {
  // 정기결제일이 현재 + 7일 보다 큰 사용자 검색
  const query = {
    $and: [
      {
        'payment.subscriptionNext': {
          $gte: new Date(new Date().getTime() + 7 * 24 * 60 * 60 * 1000),
        },
      },
      { userEmail: { $ne: null } },
      { 'payment.subscription': 1 },
    ],
  };

  const targetUsers = await User.find(query);

  let jobList2 = schedule.scheduledJobs;
  let job_mail = [];

  for (let index = 0; index < targetUsers.length; index++) {
    if (jobList2['mail-' + targetUsers[index]._id])
      jobList2['mail-' + targetUsers[index]._id].cancel();

    // 테스트 설정
    if (SEND_MAIL_EXE) {
      let sendDay = momentTz.tz(
        moment(targetUsers[index].payment.subscriptionNext),
        'Asia/Seoul',
      );

      sendDay.subtract(7, 'days');

      job_mail[index] = schedule.scheduleJob(
        'mail-' + targetUsers[index]._id,
        sendDay.format(), 
        async function () {
          // 우선 발송내역 확인
          const sendData = await EmailSubscriptionNotice.findOne({
            userId: targetUsers[index]._id,
            userEmail: targetUsers[index].userEmail,
            sendDay: moment().format('YYYY-MM-DD'), // 한국시간대 발송일
          });

          // 메일 발송
          if (!sendData) {
            // 메일 발송을 위한 구독 상태 확인
            const registerResult = await addSubscriberList(targetUsers[index]);

            if (registerResult.isSuccessed) {
              // user countryCode에 따라 템플릿 분기 처리
              let template_url = CONF.STIBEE.URL_KR;
              if (targetUsers[index].countryCode !== 'KR')
                template_url = CONF.STIBEE.URL_ETC;

              const invoice = await Invoice.findById(
                targetUsers[index].payment.invoiceId,
              );

              let st_price = invoice.regularPrice;
              if (invoice.snsUpload === 1)
                st_price += invoice.regularPrice + invoice.snsUploadPrice;

              const st_discount = st_price - invoice.price;

              const data = {
                name: targetUsers[index].userName,
                plan: targetUsers[index].payment.detail,
                payment_date: moment(
                  targetUsers[index].payment.subscriptionExpire,
                ).format('YYYY-MM-DD'),
                st_price: st_price.toLocaleString(), // "," 및 string type 적용
                st_discount: st_discount.toLocaleString(), // "," 및 string type 적용
                st_totalprice: invoice.price.toLocaleString(), // "," 및 string type 적용
                subscriber: targetUsers[index].userEmail,
              };

              const config = {
                method: 'post',
                url: template_url,
                headers: {
                  'Content-Type': 'application/json',
                  AccessToken: CONF.STIBEE.ACCESS_TOKEN,
                },
                data,
              };
              let isSent = 0;
              await axios(config).then(async function (res) {
                if (res.data == 'ok') {
                  isSent = 1;
                } else {
                  throw res.data;
                }
              });

              // 사용자 메일 발송 결과 저장
              const newMail = new EmailSubscriptionNotice({
                userId: targetUsers[index]._id,
                userEmail: targetUsers[index].userEmail,
                sendDay: moment().format('YYYY-MM-DD'),
                isSent: isSent,
              });
              await newMail.save();
            }
          } else {
            console.log(
              'subscription_mail_scheduler() > 발송내역이 있으므로 발송안함!',
            );
          }
        },
      );
    } else {
      if (
        targetUsers[index].userEmail === 'jake@vplate.io' ||
        targetUsers[index].userEmail === 'jake8@vplate.io' ||
        targetUsers[index].userEmail === 'radih@vplate.io'
      ) {
        // 발송시간 처리는 스케줄이 서버기준이기때문에 한국시간대
        let sendDay = momentTz.tz(
          moment(targetUsers[index].payment.subscriptionNext),
          'Asia/Seoul',
        );

        sendDay.subtract(7, 'days');

        job_mail[index] = schedule.scheduleJob(
          'mail-' + targetUsers[index]._id,
          sendDay.format(), 
          async function () {
            // 우선 발송내역 확인
            const sendData = await EmailSubscriptionNotice.findOne({
              userId: targetUsers[index]._id,
              userEmail: targetUsers[index].userEmail,
              sendDay: moment().format('YYYY-MM-DD'),
            });

            // 메일 발송
            if (!sendData) {
              // 메일 발송을 위한 구독 상태 확인
              const registerResult = await addSubscriberList(
                targetUsers[index],
              );

              if (registerResult.isSuccessed) {
                // user countryCode에 따라 템플릿 분기 처리
                let template_url = CONF.STIBEE.URL_KR;
                if (targetUsers[index].countryCode !== 'KR')
                  template_url = CONF.STIBEE.URL_ETC;

                const invoice = await Invoice.findById(
                  targetUsers[index].payment.invoiceId,
                );

                let st_price = invoice.regularPrice;
                if (invoice.snsUpload === 1)
                  st_price += invoice.regularPrice + invoice.snsUploadPrice;

                const st_discount = st_price - invoice.price;

                const data = {
                  name: targetUsers[index].userName,
                  plan: targetUsers[index].payment.detail,
                  payment_date: moment(
                    targetUsers[index].payment.subscriptionExpire,
                  ).format('YYYY-MM-DD'),
                  st_price: st_price.toLocaleString(), // "," 및 string type 적용
                  st_discount: st_discount.toLocaleString(), // "," 및 string type 적용
                  st_totalprice: invoice.price.toLocaleString(), // "," 및 string type 적용
                  subscriber: targetUsers[index].userEmail,
                };

                const config = {
                  method: 'post',
                  url: template_url,
                  headers: {
                    'Content-Type': 'application/json',
                    AccessToken: CONF.STIBEE.ACCESS_TOKEN,
                  },
                  data,
                };
                let isSent = 0;
                await axios(config).then(async function (res) {
                  console.log(res.data);
                  if (res.data == 'ok') {
                    console.log('subscription_mail_scheduler() > MAIL_SUCCESS');
                    isSent = 1;
                  } else {
                    console.log('subscription_mail_scheduler() > MAIL_FAIL');
                    throw res.data;
                  }
                });

                // 사용자 메일 발송 결과 저장
                const newMail = new EmailSubscriptionNotice({
                  userId: targetUsers[index]._id,
                  userEmail: targetUsers[index].userEmail,
                  sendDay: moment().format('YYYY-MM-DD'), // 한국 시간대 발송일
                  isSent: isSent,
                });
                await newMail.save();
              }
            } else {
              console.log(
                'subscription_mail_scheduler() > 발송내역이 있으므로 발송안함!',
              );
            }
          },
        );
      }
    }
  }
}
// 메일 발송을 위한 구독여부 확인
async function addSubscriberList(userInfo) {
  const data = JSON.stringify({
    eventOccuredBy: 'MANUAL',
    confirmEmailYN: 'N',
    subscribers: [
      {
        email: userInfo.userEmail,
        name: userInfo.userName,
      },
    ],
  });

  const config = {
    method: 'post',
    url: CONF.STIBEE.SUBSCRIBER_URL,
    headers: {
      'Content-Type': 'application/json',
      AccessToken: CONF.STIBEE.ACCESS_TOKEN,
    },
    data: data,
  };

  let isSuccessed = false;
  let errMsg = '';

  await axios(config).then(async function (res) {
    if (res.data.Ok) {
      console.log('REGISTER_SUCCESS');
      isSuccessed = true;
    } else {
      console.log('REGISTER_FAIL');
      isSuccessed = false;
      errMsg = res.data.Error;
    }
  });

  return {
    isSuccessed: isSuccessed,
    errMsg: errMsg,
  };
}
// 서버 시작, 재시작시 정기 구독 안내 메일 대상자 처리 (최초 실행)
subscription_mail_scheduler();
// 하루에 정오에 한번 정기 구독 안내 메일 대상자 갱신
const job = schedule.scheduleJob('0 0 12 * * *', function () {
  subscription_mail_scheduler();
});

function getNextPaymentDate(startPaymentDate, period) {
  switch (period) {
    case 1: // 월간 결제
      // return new Date(lastPaymentDate.setMonth(lastPaymentDate.getMonth() + 1))
      const inputDate = momentTz.tz(moment(startPaymentDate), 'Asia/Seoul');
      const subscriptionStartStr = inputDate.toISOString(); // 구독 시작일 String type
      const subscriptionStart = momentTz.tz(
        moment(subscriptionStartStr),
        'Asia/Seoul',
      ); // 구독 시작일 Date type
      const monthDiff = momentTz(moment(), 'Asia/Seoul')
        .startOf('day')
        .diff(inputDate.startOf('day'), 'month'); // 시작일 부터 오늘 사이의 개월수 차이
      const paymentStart = momentTz.tz(
        moment(subscriptionStartStr),
        'Asia/Seoul',
      ); // 구독 시작일 Date type
      const paymentStartDate = paymentStart.date(); // 구독 시작일 날짜

      const nextPaymentDate = momentTz
        .tz(moment(subscriptionStartStr), 'Asia/Seoul')
        .add(monthDiff + 1, 'month'); // 다음 결제 예정일
      const nextPaymentEndDateOfMonth = momentTz
        .tz(moment(subscriptionStartStr), 'Asia/Seoul')
        .add(monthDiff + 1, 'month')
        .endOf('month')
        .date(); // 다음 결제 예정일 마지막 날짜

      if (nextPaymentEndDateOfMonth < paymentStartDate) {
        // 다음 결제 예정 월 마지막 날짜보다 구독 시작일의 날짜가 클때 예외처리 (ex. 2월)
        nextPaymentDate.date(nextPaymentEndDateOfMonth); // 다음 결제 예정일을 다음 결제 예정 월 마지막 날짜로 치환
      } else {
        // 날짜가 바뀌는 경우에 대한 처리 (ex. 02-28T23:59:59 결제 요청 => 03-01T00:00:01 결제 완료)
        nextPaymentDate.date(paymentStartDate);
      }

      return new Date(nextPaymentDate);
    case 2: // 연간 결제
      // return new Date(lastPaymentDate.setFullYear(lastPaymentDate.getFullYear() + 1))
      const yearly_inputDate = momentTz.tz(
        moment(startPaymentDate),
        'Asia/Seoul',
      );
      const yearly_subscriptionStartStr = yearly_inputDate.toISOString(); // 구독 시작일 String type
      const yearly_subscriptionStart = momentTz.tz(
        moment(yearly_subscriptionStartStr),
        'Asia/Seoul',
      ); // 구독 시작일 Date type
      const yearDiff = momentTz(moment(), 'Asia/Seoul')
        .startOf('day')
        .diff(yearly_inputDate.startOf('day'), 'year'); // 시작일 부터 오늘 사이의 개월수 차이
      const yearly_paymentStart = momentTz.tz(
        moment(yearly_subscriptionStartStr),
        'Asia/Seoul',
      ); // 구독 시작일 Date type
      const yearly_paymentStartDate = yearly_paymentStart.date(); // 구독 시작일 날짜

      const yearly_nextPaymentDate = momentTz
        .tz(moment(yearly_subscriptionStartStr), 'Asia/Seoul')
        .add(yearDiff + 1, 'year'); // 다음 결제 예정일
      const yearly_nextPaymentEndDateOfMonth = momentTz
        .tz(moment(yearly_subscriptionStartStr), 'Asia/Seoul')
        .add(yearDiff + 1, 'year')
        .endOf('month')
        .date(); // 다음 결제 예정일 마지막 날짜

      if (yearly_nextPaymentEndDateOfMonth < yearly_paymentStartDate) {
        // 다음 결제 예정 월 마지막 날짜보다 구독 시작일의 날짜가 클때 예외처리 (ex. 2월)
        yearly_nextPaymentDate.date(yearly_nextPaymentEndDateOfMonth); // 다음 결제 예정일을 다음 결제 예정 월 마지막 날짜로 치환
      } else {
        // 날짜가 바뀌는 경우에 대한 처리 (ex. 02-28T23:59:59 결제 요청 => 03-01T00:00:01 결제 완료)
        yearly_nextPaymentDate.date(yearly_paymentStartDate);
      }

      return new Date(yearly_nextPaymentDate);
    default:
      throw 'undefined period : ' + period;
  }
}

async function cancelSubscribe(userId) {
  // 1. search user document
  const user = await User.findById(userId)
    .select('+payment.billingKey')
    .select('+payment.reserveId');
  // 2. get bootpay token
  // const bootpayGetTokenResult = bootpayResultToJson(await BootpayRest.getAccessToken())
  // if (!bootpayTokenResultCheck(bootpayGetTokenResult)) {
  // 	throw {
  // 		code: 'BOOTPAY_ACCESS_TOKEN_ERROR',
  // 		message: bootpayGetTokenResult
  // 	}
  // }
  // 2. cancel bootpay billing reserve
  // const bootpayBillingReserveCancel = bootpayResultToJson(await BootpayRest.destroySubscribeBillingReserveCancel(user.payment.reserveId))
  // if (!bootpayBillingReserveCancel) {
  // 	throw {
  // 		code: 'Bootpay_BILLING_RESERVE_CANCEL_ERROR',
  // 		message: 'bootpay billing reserve cancel error'
  // 	}
  // }

  // 3. cancel bootpay billing key
  // const bootpayDestroySubscribeBillingKey = bootpayResultToJson(await BootpayRest.destroySubscribeBillingKey(user.payment.billingKey))
  // if (!bootpayDestroySubscribeBillingKey) {
  // 	throw {
  // 		code: 'BOOTPAY_DESTROY_BILLING_KEY_ERROR',
  // 		message: 'bootpay destroy billing key error'
  // 	}
  // }
  // 4. update user document

  try {
    let list = schedule.scheduledJobs;
    let isScheduled = false;
    for (const [key, value] of Object.entries(list)) {
      if (userId == key) {
        isScheduled = true;
        break;
      }
    }
    if (isScheduled) list[userId].cancel();
    utils.sendMessage(
      `${user.userName}(${user._id})님의 정기결제(${user.payment.detail})가 해지되었습니다.`,
    );
  } catch (error) {
    console.log(error);
    utils.sendMessage(
      `${user.userName}(${user._id})님의 정기결제 해제오류. 스케쥴 확인`,
    );
  }

  user.payment.reserveId = null;
  user.payment.billingKey = null;
  user.payment.subscriptionNext = null;
  await user.save();

  //return bootpayDestroySubscribeBillingKey
  return user.payment;
}

// 구독 취소
exports.billingKey_cancel = async (req, res) => {
  // TODO : 언어 별 처리가 필요없는가?
  const session = await db.startSession();
  session.startTransaction();
  const { userId } = req.userData;
  try {
    const bootpayDestroySubscribeBillingKey = await cancelSubscribe(userId);

    return res.json({
      code: 'SUCCESS',
      result: bootpayDestroySubscribeBillingKey,
    });
  } catch (err) {
    await session.abortTransaction();
    // 에러 핸들링은 공통으로
    utils.invoice_error_log({
      title: 'billingKey_cancel',
      userId: userId,
      err: err,
    });
    const code = err.code ? err.code : 'BILLING_CANCEL_ERROR';
    return res.json({
      code: code,
      err,
    });
  } finally {
    session.endSession();
  }
};

function deviceChecker(userAgent) {
  if (!userAgent) return 'DESKTOP';

  if (
    /Mobile|iP(hone|od|ad)|Android|BlackBerry|IEMobile|Kindle|NetFront|Silk-Accelerated|(hpw|web)OS|Fennec|Minimo|Opera M(obi|ini)|Blazer|Dolfin|Dolphin|Skyfire|Zune/.test(
      userAgent,
    )
  ) {
    return 'MOBILE';
  } else {
    return 'DESKTOP';
  }
}

exports.paypleResultInvoice = async (req, res) => {
  try {
    const { invoiceId } = req.params;
    if (!invoiceId) throw 'PAYMENT_RESULT_ID_NOT_FOUND';

    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) throw 'INVOICE_NOT_FOUND';

    return res.json({
      code: 'SUCCESS',
      data: invoice,
    });
  } catch (error) {
    console.log(error);
    return res.json({
      code: 'FAIL',
    });
  }
};
