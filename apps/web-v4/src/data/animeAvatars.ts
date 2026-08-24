export const ANIME_MALE_AVATARS: Record<string, string> = {
  '苏烬': '/v4/src/assets/images/anime_boy_sujin_1787152463163.jpg',
  'char-sujin': '/v4/src/assets/images/anime_boy_sujin_1787152463163.jpg',
  '屿白': '/v4/src/assets/images/anime_boy_yubai_1787152439903.jpg',
  'char-yubai': '/v4/src/assets/images/anime_boy_yubai_1787152439903.jpg',
  '阿言': '/v4/src/assets/images/anime_boy_ayan_1787152449963.jpg',
  'char-ayan': '/v4/src/assets/images/anime_boy_ayan_1787152449963.jpg',
  '顾砚': '/v4/src/assets/images/anime_boy_guyan_1787152475379.jpg',
  'char-guyan': '/v4/src/assets/images/anime_boy_guyan_1787152475379.jpg',
  '厉承渊': '/v4/src/assets/images/anime_boy_lichenyuan_1787152489006.jpg',
  'char-lichenyuan': '/v4/src/assets/images/anime_boy_lichenyuan_1787152489006.jpg',
  '沈星回': '/v4/src/assets/images/anime_boy_shenxinghui_1787152502382.jpg',
  'char-shenxinghui': '/v4/src/assets/images/anime_boy_shenxinghui_1787152502382.jpg',
  '林肆': '/v4/src/assets/images/anime_boy_linsi_1787152516323.jpg',
  'char-linsi': '/v4/src/assets/images/anime_boy_linsi_1787152516323.jpg',
  '陈宇翔': '/v4/src/assets/images/anime_boy_chenyuxiang_1787152529189.jpg',
  'char-chenyuxiang': '/v4/src/assets/images/anime_boy_chenyuxiang_1787152529189.jpg',
  '林予诺': '/v4/src/assets/images/anime_boy_guyan_1787152475379.jpg',
  'char-linyunu': '/v4/src/assets/images/anime_boy_guyan_1787152475379.jpg',
  '林溯': '/v4/src/assets/images/anime_boy_sujin_1787152463163.jpg',
  'char-linsu': '/v4/src/assets/images/anime_boy_sujin_1787152463163.jpg',
  '白景安': '/v4/src/assets/images/anime_boy_lichenyuan_1787152489006.jpg',
  'char-baijingan': '/v4/src/assets/images/anime_boy_lichenyuan_1787152489006.jpg',
  '陆沉': '/v4/src/assets/images/anime_boy_lichenyuan_1787152489006.jpg',
  '齐司礼': '/v4/src/assets/images/anime_boy_yubai_1787152439903.jpg',
  '萧逸': '/v4/src/assets/images/anime_boy_ayan_1787152449963.jpg',
  '查理苏': '/v4/src/assets/images/anime_boy_linsi_1787152516323.jpg',
};

export const DEFAULT_ANIME_MALE_AVATAR = '/v4/src/assets/images/anime_boy_yubai_1787152439903.jpg';

export function getAnimeMaleAvatar(nameOrId?: string): string {
  if (!nameOrId) return DEFAULT_ANIME_MALE_AVATAR;
  if (ANIME_MALE_AVATARS[nameOrId]) {
    return ANIME_MALE_AVATARS[nameOrId];
  }
  // Try finding by sub-match
  const matchKey = Object.keys(ANIME_MALE_AVATARS).find((k) =>
    nameOrId.includes(k) || k.includes(nameOrId)
  );
  if (matchKey) {
    return ANIME_MALE_AVATARS[matchKey];
  }
  return DEFAULT_ANIME_MALE_AVATAR;
}
