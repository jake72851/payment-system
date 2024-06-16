const axios = require('axios');

const CONF = require('../../config');

const headers = {
  Referer:
    process.env.NODE_ENV == 'production'
      ? CONF.PAYPLE.production.Referer
      : CONF.PAYPLE.development.Referer,
};
const AUTH_URL_KO =
  process.env.NODE_ENV == 'production'
    ? CONF.PAYPLE.production.AUTH_URL
    : CONF.PAYPLE.development.AUTH_URL;
const CERT_URL =
  process.env.NODE_ENV == 'production'
    ? CONF.PAYPLE.production.CERT_URL
    : CONF.PAYPLE.development.CERT_URL;
const BILLING_BASE_URL =
  process.env.NODE_ENV == 'production'
    ? CONF.PAYPLE.production.BILLING_BASE_URL
    : CONF.PAYPLE.development.BILLING_BASE_URL;
const subDomain = process.env.NODE_ENV == 'production' ? 'api' : 'tapi';
const PARTNER_VALID_PARAMS_KO = {
  cst_id:
    process.env.NODE_ENV == 'production'
      ? CONF.PAYPLE.production.CST_ID
      : CONF.PAYPLE.development.CST_ID,
  custKey:
    process.env.NODE_ENV == 'production'
      ? CONF.PAYPLE.production.CUST_KEY
      : CONF.PAYPLE.development.CUST_KEY,
};

const AUTH_URL_GLOBAL =
  process.env.NODE_ENV == 'production'
    ? CONF.PAYPLE.production.AUTH_URL_GLOBAL
    : CONF.PAYPLE.development.AUTH_URL_GLOBAL;
const SERVICE_ID_GLOBAL =
  process.env.NODE_ENV == 'production'
    ? CONF.PAYPLE.production.SERVICE_ID_GLOBAL
    : CONF.PAYPLE.development.SERVICE_ID_GLOBAL;
const SERVICE_KEY_GLOBAL =
  process.env.NODE_ENV == 'production'
    ? CONF.PAYPLE.production.SERVICE_KEY_GLOBAL
    : CONF.PAYPLE.development.SERVICE_KEY_GLOBAL;
const CODE_GLOBAL =
  process.env.NODE_ENV == 'production'
    ? CONF.PAYPLE.production.CODE_GLOBAL
    : CONF.PAYPLE.development.CODE_GLOBAL;
const BILLING_URL_GLOBAL =
  process.env.NODE_ENV == 'production'
    ? CONF.PAYPLE.production.BILLING_URL_GLOBAL
    : CONF.PAYPLE.development.BILLING_URL_GLOBAL;
const PARTNER_VALID_PARAMS_GLOBAL = {
  service_id: SERVICE_ID_GLOBAL,
  service_key: SERVICE_KEY_GLOBAL,
  code: CODE_GLOBAL,
};

async function partnerValid() {
  try {
    const paypleRespose = await axios.post(
      AUTH_URL_KO,
      PARTNER_VALID_PARAMS_KO,
      { headers: headers },
    );
    if (
      !paypleRespose.data ||
      paypleRespose.data.result.toLowerCase() != 'success' ||
      !paypleRespose.data.AuthKey ||
      !paypleRespose.data.return_url
    ) {
      console.log('PAYPLE_MSG : ' + paypleRespose.data.result_msg);
      throw 'PAYPLE_PARTNER_VALIDATION_FAILED';
    }
    console.log('PAYPLE PARTNER VALIDATION SUCCESSED');

    console.log('----------- PAYPLE PARTNER VALIDATION -----------');
    console.log(paypleRespose.data);
    console.log('-------------------------------------------------');

    return {
      isSuccess: true,
      result: paypleRespose.data,
    };
  } catch (error) {
    return {
      isSuccess: false,
    };
  }
}

exports.Payment_KO = async (user, device, invoice) => {
  try {
    // 페이플 파트너 인증
    const partnerValidResult = await partnerValid();
    if (!partnerValidResult.isSuccess) throw 'PAYPLE_PARTNER_VALIDATION_FAILED';

    /**
     * 국내 결제에서의 사용자 디바이스별 결제창 방식 분기처리를 위한 경로
     * PC : 레이어팝업 (상대경로)
     * Mobile : POST redirection (절대경로)
     */
    let PCD_RST_URL = '/v3/invoice2/payment/cert-pc/' + invoice._id;
    if (device == 'MOBILE')
      PCD_RST_URL = `https://${subDomain}.vplate.io/v3/invoice2/payment/cert-mobile/${invoice._id}`;
    const PAYPLE_REQ_OBJ = {
      PCD_PAY_TYPE: 'card',
      PCD_PAY_WORK: 'CERT',
      /* 01 : 빌링키결제 */
      PCD_CARD_VER: '01',
      PCD_PAY_GOODS: invoice.detail, // 상품명
      PCD_PAY_TOTAL: invoice.price, // 결제 가격
      PCD_RST_URL: PCD_RST_URL,
      PCD_PAY_OID: invoice._id,
      /* 파트너 인증시 받은 AuthKey 값 입력  */
      PCD_AUTH_KEY: partnerValidResult.result.AuthKey,
      /* 파트너 인증시 받은 return_url 값 입력  */
      PCD_PAY_URL: partnerValidResult.result.return_url,
      PCD_PAYER_NAME: user.userName,
      PCD_PAYER_HP: user.userPhoneNumber,
    };

    return {
      isSuccess: true,
      PAYPLE_REQ_OBJ: PAYPLE_REQ_OBJ,
    };
  } catch (error) {
    console.log(error);
    return {
      isSuccess: false,
    };
  }
};

exports.CERT = async (data) => {
  try {
    const CERT_PARAMS = {
      PCD_CST_ID: PARTNER_VALID_PARAMS_KO.cst_id,
      PCD_CUST_KEY: PARTNER_VALID_PARAMS_KO.custKey,
      PCD_AUTH_KEY: data.PCD_AUTH_KEY, // "결제요청 후 리턴받은 PCD_AUTH_KEY"
      PCD_PAY_REQKEY: data.PCD_PAY_REQKEY, // "결제요청 후 리턴받은 PCD_PAY_REQKEY"
      PCD_PAYER_ID: data.PCD_PAYER_ID, // "결제요청 후 리턴받은 PCD_PAYER_ID"
    };

    const paypleRespose = await axios.post(CERT_URL, CERT_PARAMS, {
      headers: headers,
    });
    console.log('CERT > paypleRespose =' + paypleRespose);

    let paypleCode = null;

    // 혹시 알수 없는 오류가 발생했다면
    if (!paypleRespose.data) {
      console.log('CERT > PAYPLE_MSG =' + paypleRespose.data.PCD_PAY_MSG);
      throw {
        msg: 'PAYPLE_PARTNER_VALIDATION_FAILED',
        paypleRespose: paypleRespose,
      };
    }

    // 오류 코드를 전달해야 한다면
    if (paypleRespose.data.PCD_PAY_RST.toLowerCase() != 'success') {
      console.log('CERT > 페이플 오류코드 처리 필요!');
      console.log('CERT > PAYPLE_MSG = ' + paypleRespose.data.PCD_PAY_MSG);
      console.log(
        'CERT > paypleRespose.data.PCD_PAY_CODE =',
        paypleRespose.data.PCD_PAY_CODE,
      );
      // [TEST] 삭제
      let str = paypleRespose.data.PCD_PAY_CODE;
      if (str.startsWith('[TEST]')) {
        str = str.replace('[TEST]', '');
      }
      paypleCode = str;
    }

    return {
      isSuccess: true,
      result: paypleRespose.data,
      paypleCode: paypleCode,
    };
  } catch (error) {
    console.error('CERT > error =', error);
    let data;
    if (error.paypleRespose) data = error.paypleRespose;
    return {
      isSuccess: false,
      result: data,
    };
  }
};

exports.billingPayment_KO = async (user, invoice) => {
  try {
    const BILLING_PARTNER_VALID_PARAMS = {
      cst_id: PARTNER_VALID_PARAMS_KO.cst_id,
      custKey: PARTNER_VALID_PARAMS_KO.custKey,
      PCD_PAY_TYPE: 'card',
      PCD_SIMPLE_FLAG: 'Y',
    };

    const partnerValid = await axios.post(
      AUTH_URL_KO,
      BILLING_PARTNER_VALID_PARAMS,
      { headers: headers },
    );
    if (
      !partnerValid.data ||
      partnerValid.data.result.toLowerCase() != 'success'
    ) {
      console.log('PAYPLE_MSG : ' + partnerValid.data.result_msg);
      throw 'PAYPLE_PARTNER_VALIDATION_FAILED';
    }
    console.log('PAYPLE PARTNER VALIDATION SUCCESSED');

    console.log('----------- PAYPLE PARTNER VALIDATION -----------');
    console.log(partnerValid.data);
    console.log('-------------------------------------------------');

    const PAYMENT_BILLING_REQ_URL = `${BILLING_BASE_URL}${partnerValid.data.PCD_PAY_URL}`;
    const PAYMENT_BILLING_REQ_OBJ = {
      PCD_CST_ID: partnerValid.data.cst_id, // 파트너 인증 후 리턴받은 cst_id
      PCD_CUST_KEY: partnerValid.data.custKey, // 파트너 인증 후 리턴받은 custKey
      PCD_AUTH_KEY: partnerValid.data.AuthKey, // 파트너 인증 후 리턴받은 AuthKey
      PCD_PAY_TYPE: 'card', // card
      PCD_PAYER_ID: user.payment.paypleBillingKey, // d0to...
      PCD_PAY_GOODS: invoice.detail, // 테스트 상품명
      PCD_PAY_TOTAL: invoice.price, // 100
      PCD_SIMPLE_FLAG: 'Y', // Y
      PCD_PAY_OID: invoice._id,
      PCD_PAYER_NAME: user.userName,
    };

    if (user.countryCode && user.countryCode == 'KR') {
      PAYMENT_BILLING_REQ_OBJ.PCD_PAYER_HP = user.userPhoneNumber;
    } else {
      PAYMENT_BILLING_REQ_OBJ.PCD_PAYER_EMAIL = user.userEmail;
    }

    const billingRequest = await axios.post(
      PAYMENT_BILLING_REQ_URL,
      PAYMENT_BILLING_REQ_OBJ,
      { headers: headers },
    );
    if (
      !billingRequest.data ||
      billingRequest.data.PCD_PAY_RST.toLowerCase() != 'success'
    ) {
      console.log('PAYPLE_MSG : ' + billingRequest.data.PCD_PAY_MSG);
      throw { msg: 'PAYPLE_BILLING_FAILED', billingRequest: billingRequest };
    }

    return {
      isSuccess: true,
      result: billingRequest.data,
    };
  } catch (error) {
    console.log(error);
    let data;
    if (error.billingRequest) data = error.billingRequest;
    return {
      isSuccess: false,
      result: data,
    };
  }
};

async function partnerValid_GLOBAL() {
  try {
    const paypleRespose = await axios.post(
      AUTH_URL_GLOBAL,
      PARTNER_VALID_PARAMS_GLOBAL,
      { headers: headers },
    );
    if (
      !paypleRespose.data ||
      paypleRespose.data.result != 'T0000' ||
      paypleRespose.data.message.toLowerCase() != 'process success' ||
      !paypleRespose.data.access_token
    ) {
      console.log('PAYPLE_MSG : ' + paypleRespose.data.message);
      throw 'PAYPLE_GLOBAL_PARTNER_VALIDATION_FAILED';
    }
    console.log('PAYPLE GLOBAL PARTNER VALIDATION SUCCESSED');

    console.log('----------- PAYPLE GLOBAL PARTNER VALIDATION -----------');
    console.log(paypleRespose.data);
    console.log('-------------------------------------------------');

    return {
      isSuccess: true,
      result: paypleRespose.data,
    };
  } catch (error) {
    return {
      isSuccess: false,
    };
  }
}

exports.Payment_GLOBAL = async (user, device, invoice) => {
  try {
    // 페이플 글로벌 파트너 인증
    const partnerValidResult = await partnerValid_GLOBAL();
    if (!partnerValidResult.isSuccess) throw 'PAYPLE_PARTNER_VALIDATION_FAILED';

    let isDirect = '';
    if (device == 'MOBILE') isDirect = 'Y';
    const PAYPLE_GLOBAL_REQ_OBJ = {
      Authorization: partnerValidResult.result.access_token,
      service_id: SERVICE_ID_GLOBAL,
      service_oid: invoice._id,
      comments: invoice.detail,
      totalAmount: invoice.price,
      currency: 'USD',
      firstName: user.userName,
      email: user.userEmail,
      resultUrl: `https://${subDomain}.vplate.io/v3/invoice2/payment/global/${invoice._id}`,
      isDirect: isDirect,
      // 추가
      country: 'KR',
      administrativeArea: 'KR',
      locality: 'Mapo-gu Seoul',
      address: '125 Wausan-ro',
      postalCode: '04054',
    };

    if (process.env.NODE_ENV != 'production')
      PAYPLE_GLOBAL_REQ_OBJ.payCls = 'demo';

    return {
      isSuccess: true,
      PAYPLE_REQ_OBJ: PAYPLE_GLOBAL_REQ_OBJ,
    };
  } catch (error) {
    console.log(error);
    return {
      isSuccess: false,
    };
  }
};

exports.billingPayment_GLOBAL = async (user, invoice) => {
  try {
    // 페이플 글로벌 파트너 인증
    const partnerValidResult = await partnerValid_GLOBAL();
    if (!partnerValidResult.isSuccess) throw 'PAYPLE_PARTNER_VALIDATION_FAILED';

    const BILLING_HEADERS = {
      Referer: headers.Referer,
      Authorization: `Bearer ${partnerValidResult.result.access_token}`,
    };

    const PAYPLE_GLOBA_BILLINGL_REQ_OBJ = {
      service_id: SERVICE_ID_GLOBAL, //"demo",
      service_oid: invoice._id, //"test120220608512351",
      comments: invoice.detail, //"테스트상품명",
      billing_key: user.payment.paypleBillingKey, //"MlNCQ0pHMn…",
      totalAmount: invoice.price, //"0.10",
      currency: 'USD',
      firstName: user.userName,
      email: user.userEmail, //"test@payple.kr",
      resultUrl: `https://${subDomain}.vplate.io/v3/invoice2/${invoice._id}`, //"http://test.shop.com"
      // 추가
      country: 'KR',
      administrativeArea: 'KR',
      locality: 'Mapo-gu Seoul',
      address: '125 Wausan-ro',
      postalCode: '04054',
    };

    const billingRequest = await axios.post(
      BILLING_URL_GLOBAL,
      PAYPLE_GLOBA_BILLINGL_REQ_OBJ,
      { headers: BILLING_HEADERS },
    );
    if (!billingRequest.data || billingRequest.data.result != 'A0000') {
      console.log('PAYPLE_MSG : ' + billingRequest.data.message);
      throw { msg: 'PAYPLE_BILLING_FAILED', billingRequest: billingRequest };
    }

    return {
      isSuccess: true,
      result: billingRequest.data,
    };
  } catch (error) {
    console.log(error);
    let data;
    if (error.billingRequest) data = error.billingRequest;
    return {
      isSuccess: false,
      result: data,
    };
  }
};

exports.cancelPayment_KO = async (invoice) => {
  try {
    const PARTNER_VALID_PARAMS = {
      cst_id: PARTNER_VALID_PARAMS_KO.cst_id,
      custKey: PARTNER_VALID_PARAMS_KO.custKey,
      PCD_PAYCANCEL_FLAG: 'Y',
    };

    const payplePartnerValidRespose = await axios.post(
      AUTH_URL_KO,
      PARTNER_VALID_PARAMS,
      { headers: headers },
    );
    if (
      !payplePartnerValidRespose.data ||
      payplePartnerValidRespose.data.result.toLowerCase() != 'success'
    ) {
      console.log('PAYPLE_MSG : ' + payplePartnerValidRespose.data.result_msg);
      throw 'PAYPLE_PARTNER_VALIDATION_FAILED';
    }

    let invoiceDate = new Date(invoice.updatedAt);
    let year = invoiceDate.getUTCFullYear();
    let month = invoiceDate.getUTCMonth() + 1; // JavaScript month is 0-11
    let day = invoiceDate.getUTCDate();

    // Ensure month and day are two digits
    month = month < 10 ? '0' + month : month;
    day = day < 10 ? '0' + day : day;

    const PCD_PAY_DATE = '' + year + month + day;

    const CANCEL_OBJ = {
      PCD_CST_ID: payplePartnerValidRespose.data.cst_id, // "파트너 인증 후 리턴받은 cst_id",
      PCD_CUST_KEY: payplePartnerValidRespose.data.custKey, // "파트너 인증 후 리턴받은 custKey",
      PCD_AUTH_KEY: payplePartnerValidRespose.data.AuthKey, // "파트너 인증 후 리턴받은 AuthKey",
      PCD_REFUND_KEY: CONF.PAYPLE.production.CANCEL_KEY, // "a41ce010e...",
      PCD_PAYCANCEL_FLAG: 'Y',
      PCD_PAY_OID: invoice._id, //"test099942200156938",
      PCD_PAY_DATE: PCD_PAY_DATE, //"20200320",
      PCD_REFUND_TOTAL: invoice.price, //"1000"
    };

    const REQ_CANCEL_URL = `BILLING_BASE_URL${payplePartnerValidRespose.data.PCD_PAY_URL}`;

    const paypleCancelRespose = await axios.post(REQ_CANCEL_URL, CANCEL_OBJ, {
      headers: headers,
    });
    if (
      !paypleCancelRespose.data ||
      paypleCancelRespose.data.PCD_PAY_RST.toLowerCase() != 'success'
    ) {
      console.log('PAYPLE_MSG : ' + paypleCancelRespose.data.PCD_PAY_MSG);
      throw 'PAYPLE_PARTNER_VALIDATION_FAILED';
    }

    console.log(`----- REFUND SUCCESSED - ${invoice._id} -----`);
    console.log(paypleCancelRespose.data);

    return {
      isSuccess: true,
    };
  } catch (error) {
    console.log(error);
    return {
      isSuccess: false,
    };
  }
};

exports.cancelPayment_GLOBAL = async (invoice, api_id) => {
  try {
    // 페이플 글로벌 파트너 인증
    const partnerValidResult = await partnerValid_GLOBAL();
    if (!partnerValidResult.isSuccess) throw 'PAYPLE_PARTNER_VALIDATION_FAILED';

    const CANCEL_HEADERS = {
      Referer: headers.Referer,
      Authorization: `Bearer ${partnerValidResult.result.access_token}`,
    };

    const CANCEL_OBJ = {
      service_id: SERVICE_ID_GLOBAL, //"demo",
      comments: invoice.detail, // "테스트상품명",
      service_oid: invoice._id, // "test120220608512351",
      pay_id: api_id, // "6548264741426583803027",
      totalAmount: invoice.price, // "0.10",
      currency: 'USD', // "USD"
    };
    // TEST : https://demo-api.payple.kr/gpay/cancel
    // REAL : https://api.payple.kr/gpay/cancel
    const REQ_CANCEL_URL =
      process.env.NODE_ENV == 'production'
        ? 'https://api.payple.kr/gpay/cancel'
        : 'https://demo-api.payple.kr/gpay/cancel';

    const paypleCancelRespose = await axios.post(REQ_CANCEL_URL, CANCEL_OBJ, {
      headers: CANCEL_HEADERS,
    });
    if (
      !paypleCancelRespose.data ||
      paypleCancelRespose.data.result != 'A0000'
    ) {
      console.log('PAYPLE_MSG : ' + paypleCancelRespose.data.message);
      throw 'PAYPLE_PARTNER_VALIDATION_FAILED';
    }

    console.log(`----- REFUND SUCCESSED - ${invoice._id} -----`);
    console.log(paypleCancelRespose.data);

    return {
      isSuccess: true,
    };
  } catch (error) {
    console.log(error);
    return {
      isSuccess: false,
    };
  }
};
