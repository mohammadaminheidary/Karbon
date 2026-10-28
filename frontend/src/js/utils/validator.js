export function validateLogin(username, password) {
  if (!username) {
    return {
      success: false,
      message: "نام کاربری را وارد کنید",
    };
  }


  if (username.length > 50) {
    return {
      success: false,
      message: "نام کاربری بیش از حد طولانی است",
    };
  }


  if (!password) {
    return {
      success: false,
      message: "رمز عبور را وارد کنید",
    };
  }


  const passwordBytes =
    new TextEncoder().encode(password).length;


  if (passwordBytes > 72) {
    return {
      success: false,
      message: "رمز عبور بیش از حد طولانی است",
    };
  }


  return {
    success: true,
  };
}