const axios = require('axios');
const CONF = require('../../config');

const subscriberUrl = 'https://api.stibee.com/v1/lists/207119/subscribers';
const emailTemplateUrl_koBootpay =
  'https://stibee.com/api/v1.0/auto/YmI5YzhhYWUtZTFjZi00NzJjLTk0ZGEtYzQ5Y2Y4OTI2YjY1';
const emailTemplateUrl_enBootpay =
  'https://stibee.com/api/v1.0/auto/MjM4MGVlN2QtMmFjYS00OWJhLThmOTgtOWRjOTdjMGU3NjJh';
const emailTemplateUrl_koPayple =
  'https://stibee.com/api/v1.0/auto/NTBlZTA3NmEtYjhmYy00ZThlLWFjYzQtYzJlODFjNjIxZjBk';
const emailTemplateUrl_enPayple =
  'https://stibee.com/api/v1.0/auto/ODc2Y2Q3MGEtMWI3ZC00OTNlLTk5YWUtYzljNTkxMGFmZGMz';
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
    url: subscriberUrl,
    headers: {
      'Content-Type': 'application/json',
      AccessToken:
        '...',
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
exports.sendEmail = async (userInfo, invoice) => {
  try {
    if (!userInfo || !invoice) throw 'INPUT_NOT_ENOUGH';
    if (!invoice || invoice.price == 0) throw 'INVOICE_EXCEPTION';
    console.log('CRM NO.6 - Email : ' + userInfo.userEmail);

    let emailTemplateUrl = '';
    const updatedData = {
      userId: userInfo._id,
      userEmail: userInfo.userEmail,
      planType: invoice.planType,
      subscriptionStart: userInfo.payment.subscriptionStart,
      countryCode: invoice.countryCode,
      price: invoice.price,
      coupon: invoice.coupon,
    };

    if (userInfo.userEmail.indexOf('@vplate.io') === -1) {
      const paymentData = {
        userId: userInfo._id,
        userName: userInfo.userName,
        userPhoneNumber: userInfo.userPhoneNumber,
        userEmail: userInfo.userEmail,
        createdAt: userInfo.createdAt,
        countryCode: userInfo.countryCode,
        invoiceId: invoice._id,
        planType: invoice.planType,
        coupon: invoice.coupon,
        promotion: invoice.promotion,
        price: invoice.price,
        period: invoice.period,
        detail: invoice.detail,
        countryCode: invoice.countryCode,
        snsUpload: invoice.snsUpload,
        invoice_createdAt: invoice.createdAt,
      };

      await insertPaymentInfomation(paymentData);
    }

    await updateUserInformation(updatedData);

    const registerResult = await addSubscriberList(userInfo);
    if (registerResult.isSuccessed) {
      let receiptUrl = '';

      if (invoice.receiptUrl) {
        receiptUrl = invoice.receiptUrl;
      } else if (invoice.bootpayVerifyResult != null) {
        // 단건 결제 또는 정기결제의 첫결제
        if (invoice.bootpayVerifyResult.data != null) {
          // 형식이 일정하지 않아 추가한 예외처리
          receiptUrl = invoice.bootpayVerifyResult.data.receipt_url;
        } else {
          receiptUrl = invoice.bootpayVerifyResult.receipt_url;
        }
      } else if (
        invoice.bootpaySubscribeBilling != null &&
        invoice.bootpaySubscribeBilling.data != null
      ) {
        // 정기결제 두번째 이후의 결제
        receiptUrl = invoice.bootpaySubscribeBilling.data.receipt_url;
      }

      // 페이플인 경우
      if (
        receiptUrl == '' &&
        invoice.countryCode == 'KR' &&
        invoice.paypleVerifyResult &&
        invoice.paypleVerifyResult.PCD_PAY_CARDRECEIPT
      ) {
        receiptUrl = invoice.paypleVerifyResult.PCD_PAY_CARDRECEIPT.replace(
          'https://www.danalpay.com/receipt/creditcard/view?',
          '',
        );
        emailTemplateUrl =
          invoice.languageCode == 'ko'
            ? emailTemplateUrl_koPayple
            : emailTemplateUrl_enPayple;
      }

      if (
        receiptUrl == '' &&
        invoice.countryCode != 'KR' &&
        invoice.paypleVerifyResult &&
        invoice.paypleVerifyResult.resultUrl
      ) {
        const billConfig = {
          method: 'get',
          url:
            'https://bill.vplate.io/bill?userId=' +
            invoice.userId +
            '&invoiceId=' +
            invoice._id,
          headers: {},
        };
        // console.log('sendEmail() > billConfig =', billConfig);
        const billResult = await axios(billConfig);
        // console.log('sendEmail() > billResult =', billResult);
        console.log('sendEmail() > billResult.data =', billResult.data);
        if (billResult.data.code != 'SUCCESS') throw 'VPLATE_BILL_ERROR';

        receiptUrl = billResult.data.data.replace(
          'https://vplate-s3.s3.ap-northeast-2.amazonaws.com/abroad_bills/',
          '',
        );

        emailTemplateUrl = emailTemplateUrl_enPayple;
      }

      if (!receiptUrl || receiptUrl == '') {
        throw 'RECEIPT_NOT_FOUND';
      }

      let price = (
        !invoice.regularPrice || invoice.regularPrice == 0
          ? invoice.price
          : invoice.regularPrice
      ).toString();
      let discount = (
        !invoice.regularPrice || invoice.regularPrice == 0
          ? 0
          : invoice.regularPrice - invoice.price
      ).toString();
      let totalprice = invoice.price.toString();
      if (invoice.languageCode != 'ko') {
        price = `${price} $`;
        discount = `${discount} $`;
        totalprice = `${totalprice} $`;
      }

      const utcDate = new Date(userInfo.payment.subscriptionStart);

      const kstOffset = 9 * 60 * 60 * 1000;
      const kstDate = new Date(utcDate.getTime() + kstOffset);

      const data = JSON.stringify({
        subscriber: userInfo.userEmail,
        orderId: invoice._id,
        st_price: price,
        st_discount: discount,
        st_totalprice: totalprice,
        payment_date:
          invoice.languageCode == 'ko'
            ? formatDate(kstDate)
            : formatDate(utcDate),
        link: receiptUrl,
      });

      const config = {
        method: 'post',
        url: emailTemplateUrl,
        headers: {
          'Content-Type': 'application/json',
          AccessToken:
            '...',
        },
        data: data,
      };

      await axios(config).then(async function (res) {
        console.log(res.data);
        if (res.data == 'ok') {
          console.log('MAIL_SUCCESS');
          isSent = true;
        } else {
          console.log('MAIL_FAIL');
          isSent = false;
          throw res.data;
        }
      });
      return isSent;
    } else {
      throw registerResult.errMsg;
    }
  } catch (error) {
    console.log(error);
    return false;
  }
};

async function updateUserInformation(updatedData) {
  try {
    const response = await axios.post(
      'https://vplate-tracking.vplate.io/updateUser',
      updatedData,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Secret-Key': CONF.TRACKING_SECRET_KEY,
        },
      },
    );

    console.log('User updated successfully:', response.data);
  } catch (error) {
    console.error(
      'Failed to update user:',
      error.response ? error.response.data : error.message,
    );
  }
}

async function insertPaymentInfomation(paymentData) {
  try {
    const response = await axios.post(
      'https://vplate-tracking.vplate.io/payment',
      paymentData,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Secret-Key': CONF.TRACKING_SECRET_KEY,
        },
      },
    );

    console.log('Payment_user updated successfully:', response.data);
  } catch (error) {
    console.error(
      'Failed to update user:',
      error.response ? error.response.data : error.message,
    );
  }
}

const formatDate = (date) => {
  const year = date.getUTCFullYear();
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');
  const hours = date.getUTCHours().toString().padStart(2, '0');
  const minutes = date.getUTCMinutes().toString().padStart(2, '0');
  const seconds = date.getUTCSeconds().toString().padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};
